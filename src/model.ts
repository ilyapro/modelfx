import { createKey } from './key';
import { createQueue } from './queue';
import { createSubscription } from './subscription';
import {
  Dict,
  ModelContext,
  ModelEffect,
  ModelEffectsConfig,
  ModelLive,
  Model,
  Context,
  ModelDie,
  ModelInstance,
  ModelSelection,
  ModelState,
  ModelDebugger,
  ModelDebugEvent,
  ModelDebugEventEffect,
} from './types';
import { safe } from './safe';

const idExistance: Dict<true> = {};

export function createModel<
  Name extends string,
  Params,
  Data,
  App,
  Effects extends Dict<ModelEffect<Data>>
>(
  name: Name,
  effects: ModelEffectsConfig<Params, Data, App, Effects>,
  live: ModelLive<Params, Data, App, Effects>,
): Model<
  Name,
  Params,
  Effects extends Dict<ModelEffect<infer D>> ? D : unknown,
  App,
  {
    [K in keyof Effects]: (
      ...args: Parameters<Effects[K]>
    ) => ReturnType<Effects[K]>;
  }
> {
  if (idExistance[name]) {
    if (process.env.NODE_ENV === 'development') {
      console.error(
        `Trying to create a model with a pre-existing name "${name}"`,
      );
    }
    name = Math.random().toString() as Name;
  }
  idExistance[name] = true;

  const effectKeys = Object.keys(
    effects({} as any, {} as any, {} as any, {} as any) || {},
  );

  const safeLive = safe(live);

  return (params: Params) => {
    const modelSelection = (context: Context<App>) =>
      getInstance(name, context, params, effects, effectKeys, safeLive);

    modelSelection.effects = effectKeys.reduce((acc, k) => {
      acc[k] = (...args: any) => (context: any) =>
        getInstance(
          name,
          context,
          params,
          effects,
          effectKeys,
          safeLive,
        ).effects[k](...args);
      return acc;
    }, {} as any);

    return modelSelection as any;
  };
}

export function createModelContext<App>(
  app: App,
  initialState: Dict<ModelState<any>> = {},
): ModelContext<App> {
  const instances: Dict<ModelInstance<any, any, any, App, any>> = {};

  const context: Context<App> = {
    app,
    initialState,
    instances,
  };

  let dbgr: ModelDebugger | undefined;

  return {
    dispatch: (action) => action(context),
    getAllState: () =>
      Object.keys(instances).reduce((state, key) => {
        state[key] = instances[key].getState();
        return state;
      }, {} as Dict<ModelState<any>>),
    willAllReady: async () => {
      await Promise.all(
        Object.keys(instances).map((key) => instances[key]._willReady()),
      );
    },
    getDebugger: () => {
      if (dbgr) {
        return dbgr;
      }

      const { subscribe, notify } = createSubscription();

      context.debug = {
        emitEvent: notify,
      };

      return (dbgr = {
        listenToAllEvents: subscribe,
      });
    },
  };
}

function getInstance<
  Name extends string,
  Params,
  Data,
  App,
  Effects extends Dict<ModelEffect>
>(
  name: Name,
  context: Context<App>,
  params: Params,
  effectsConfig: ModelEffectsConfig<Params, Data, App, Effects>,
  effectKeys: Array<keyof Effects>,
  live: ModelLive<Params, Data, App, Effects>,
): ModelInstance<Name, Params, Data, App, Effects> {
  const key = createKey([name, params]);

  const instance: ModelInstance<Name, Params, Data, App, Effects> | undefined =
    context.instances[key];
  if (instance) {
    return instance;
  }

  const { app, instances, initialState, debug } = context;

  const { subscribe, notify } = createSubscription();
  let usingCounter = 0;

  let state: ModelState<Data> = initialState[key];
  if (state) {
    delete initialState[key];
  } else {
    state = { isPending: false };
  }

  const getState = () => state;

  const setState = (newState: ModelState<Data>) => {
    state = newState;
    notify();
  };

  const getIsPending = () => state.isPending && !isEffectsQueueEmpty();

  const setData = (data: Data | undefined) => {
    const isPending = getIsPending();
    if (isPending === state.isPending && data === state.data) {
      return;
    }
    setState({ isPending, data });
  };

  const setError = (error: any) => {
    setState({
      isPending: getIsPending(),
      data: state.data,
      error,
    });
  };

  const setPending = () => {
    if (state.isPending) {
      return;
    }
    setState({
      data: state.data,
      error: state.error,
      isPending: true,
    });
  };

  const processEffect = (effect: ModelEffect<Data>): Promise<void> | void => {
    try {
      const result = effect();

      if (result instanceof Promise) {
        setPending();
        return result.then(setData).catch(setError);
      } else {
        setData(result);
      }
    } catch (error) {
      setError(error);
    }
  };

  const debugEmitEvent = debug
    ? (type: ModelDebugEvent['type'], effect?: ModelDebugEventEffect) => {
        const event: any = {
          type,
          model: { name, params, state },
        };
        if (effect) {
          event.effect = effect;
        }
        debug.emitEvent(event);
      }
    : () => {};

  const normalize = <D>(s: ModelSelection<any, any, D, App, any>, d: D) =>
    s(context)._normalize(d);

  const {
    add: queueEffect,
    isEmpty: isEffectsQueueEmpty,
    willReady: willEffectsReady,
  } = createQueue();

  const effects = effectKeys.reduce((acc, k: keyof Effects) => {
    acc[k] = (...args) => {
      queueEffect(() => {
        const detachedEffects: Array<() => Promise<Data | undefined>> = [];

        let isInEffect = true;

        let promise = processEffect(() =>
          effectsConfig(app, params, state.data, {
            normalize,
            detachEffect: (effect) => {
              if (isInEffect) {
                detachedEffects.push(effect);
              } else {
                queueEffect(() => processEffect(effect));
              }
            },
          })[k](...args),
        );

        if (debug) {
          if (promise) {
            debugEmitEvent('effectStart', { name: k as string, args });
            promise.then(() => {
              debugEmitEvent(!state.error ? 'effectSuccess' : 'effectError', {
                name: k as string,
                args,
              });
            });
          } else {
            debugEmitEvent(
              !state.error ? 'syncEffectSuccess' : 'syncEffectError',
              { name: k as string, args },
            );
          }
        }

        if (detachedEffects.length) {
          promise = Promise.resolve(promise)
            .then(() =>
              (function detachEffectRecursion(): Promise<void> | void {
                const effect = detachedEffects.shift();
                if (effect) {
                  return Promise.resolve(processEffect(effect)).then(
                    detachEffectRecursion,
                  );
                }
              })(),
            )
            .then(() => {
              debugEmitEvent(!state.error ? 'detachSuccess' : 'detachError', {
                name: k as string,
                args,
              });
            });
        }

        Promise.resolve(promise).then(() => {
          isInEffect = false;
        });

        return promise;
      });
    };
    return acc;
  }, {} as { [K in keyof Effects]: (...args: any) => void });

  let clearDataTimeoutId: NodeJS.Timeout | undefined;

  const clearData = ({ delay = 15000 }: { delay?: number } = {}) => {
    Promise.all([
      willEffectsReady(),
      new Promise((resolve) => {
        clearDataTimeoutId = setTimeout(resolve, delay);
      }),
    ]).then(() => {
      if (usingCounter) {
        return;
      }
      delete instances[key];
      debugEmitEvent('clearData');
    });
  };
  let die: ModelDie;

  return (instances[key] = {
    getState,

    subscribe: (listener: () => any) => {
      const unsubscribe = subscribe(listener);

      if (usingCounter++ === 0) {
        if (clearDataTimeoutId) {
          clearTimeout(clearDataTimeoutId);
        }
        debugEmitEvent('live');
        die = safe(live(effects, params, app, { subscribe, getState }));
      }

      return () => {
        unsubscribe();

        if (--usingCounter === 0) {
          die({ clearData });
          debugEmitEvent('die');
        }
      };
    },

    effects,

    _normalize(data: Data) {
      queueEffect(() => {
        processEffect(() => data);
        debugEmitEvent('normalize');
      });
    },

    _willReady: willEffectsReady,
  });
}
