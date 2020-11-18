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
} from './types';

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

  return (params: Params) => {
    const modelSelection = (context: Context<App>) =>
      getInstance(name, context, params, effects, effectKeys, live);

    modelSelection.effects = effectKeys.reduce((acc, k) => {
      acc[k] = (...args: any) => (context: any) =>
        getInstance(name, context, params, effects, effectKeys, live).effects[
          k
        ](...args);
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
      const debug =
        context.debug ||
        (context.debug = {
          subscription: createSubscription(),
        });

      return {
        listenToAllEvents: (listener) =>
          debug.subscription.subscribe((event) => {
            try {
              listener(event);
            } catch (error) {
              console.error(error);
            }
          }),
      };
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

  const { app, instances, initialState, debug } = context;

  const instance: ModelInstance<Name, Params, Data, App, Effects> | undefined =
    instances[key];
  if (instance) {
    return instance;
  }

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
    try {
      notify();
    } catch (error) {
      console.error(error);
    }
  };

  const {
    add: queueEffect,
    isEmpty: isEffectsQueueEmpty,
    willReady: willEffectsReady,
  } = createQueue();

  const processEffect = (effect: ModelEffect<Data>): Promise<void> | void => {
    const { isPending, data, error } = state;
    try {
      const result = effect();

      if (result instanceof Promise) {
        if (!isPending) {
          setState({ isPending: true, data, error });
        }

        return result.then((newData) => {
          if (newData !== data || isEffectsQueueEmpty()) {
            setState({
              isPending: !isEffectsQueueEmpty(),
              data: newData,
            });
          }
        });
      } else if (result !== data || (isPending && isEffectsQueueEmpty())) {
        setState({
          isPending: isPending && !isEffectsQueueEmpty(),
          data: result,
        });
      }
    } catch (error) {
      setState({
        isPending: !isEffectsQueueEmpty(),
        data,
        error,
      });
    }
  };

  const normalize = <D>(s: ModelSelection<any, any, D, App, any>, d: D) =>
    s(context)._normalize(d);

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
            debug.subscription.notify({
              type: 'effectStart',
              model: { name, params, state },
              effect: { name: k as string, args },
            });
            promise.then(() => {
              debug.subscription.notify({
                type: !state.error ? 'effectSuccess' : 'effectError',
                model: { name, params, state },
                effect: { name: k as string, args },
              });
            });
          } else {
            debug.subscription.notify({
              type: !state.error ? 'syncEffectSuccess' : 'syncEffectError',
              model: { name, params, state },
              effect: { name: k as string, args },
            });
          }
        }

        if (detachedEffects.length) {
          promise = Promise.resolve(promise)
            .then(() =>
              (async function detachEffectRecursion(): Promise<void> {
                const effect = detachedEffects.shift();

                if (effect) {
                  return Promise.resolve(processEffect(effect)).then(
                    detachEffectRecursion,
                  );
                }
              })(),
            )
            .then(() => {
              debug?.subscription.notify({
                type: !state.error ? 'detachSuccess' : 'detachError',
                model: { name, params, state },
                effect: { name: k as string, args },
              });
            });
        }

        isInEffect = false;

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
    });
  };
  let die: ModelDie | undefined | void;

  return (instances[key] = {
    getState,

    subscribe: (listener: () => any) => {
      const unsubscribe = subscribe(listener);

      if (usingCounter++ === 0) {
        if (live) {
          if (clearDataTimeoutId) {
            clearTimeout(clearDataTimeoutId);
          }
          try {
            debug?.subscription.notify({
              type: 'live',
              model: { name, params, state },
            });
            die = live(effects, params, app, { subscribe, getState });
          } catch (error) {
            console.error(error);
          }
        }
      }

      return () => {
        unsubscribe();

        if (--usingCounter === 0) {
          if (die) {
            die({ clearData });
          }
          debug?.subscription.notify({
            type: 'die',
            model: { name, params, state },
          });
        }
      };
    },

    effects,

    _normalize(data: Data) {
      queueEffect(() => {
        processEffect(() => data);

        debug?.subscription.notify({
          type: 'normalize',
          model: { name, params, state },
        });
      });
    },

    _willReady: willEffectsReady,
  });
}
