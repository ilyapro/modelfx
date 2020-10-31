import { createSubscription } from './subscription';

const idExistance: Dict<true> = {};

export function createModel<
  Name extends string,
  Params,
  Data,
  App,
  Effects extends {
    [x: string]: (...args: any) => Promise<Data | undefined> | Data | undefined;
  }
>(
  name: Name,
  effects: ModelEffectsConfig<Params, Data, App, Effects>,
  live: ModelLive<Params, Data, App, Effects>,
): Model<
  Name,
  Params,
  GetDataFromEffects<Effects>,
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
        `Trying to create a model with a pre-existing name ${name}`,
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

interface Context<App> {
  initialState: Dict<ModelState<any>>;
  instances: Dict<ModelInstance<any, any, any, App, any>>;
  app: App;
}
export interface ModelContext<App> {
  dispatch: ModelDispatch<App>;
  getAllState: () => Context<App>['initialState'];
  willAllReady: () => Promise<void>;
}
export function createModelContext<App>(
  app: App,
  initialState: Context<App>['initialState'] = {},
): ModelContext<App> {
  const instances: Context<App>['instances'] = {};
  const context = {
    app,
    initialState,
    instances,
  };
  return {
    dispatch: (action) => action(context),
    getAllState: () =>
      Object.keys(instances).reduce((state, key) => {
        state[key] = instances[key]!.getState();
        return state;
      }, {} as Dict<ModelState<any>>),
    willAllReady: async () => {
      await Promise.all(
        Object.keys(instances).map((key) => instances[key]!._willReady()),
      );
    },
  };
}

function getInstance<
  Name extends string,
  Params,
  Data,
  App,
  Effects extends { [x: string]: (...args: any) => any }
>(
  name: string,
  context: Context<App>,
  params: Params,
  effectsConfig: ModelEffectsConfig<Params, Data, App, Effects>,
  effectKeys: Array<keyof Effects>,
  live: ModelLive<Params, Data, App, Effects>,
): ModelInstance<Name, Params, Data, App, Effects> {
  const key =
    `${name}-` +
    JSON.stringify(
      typeof params === 'object' && !Array.isArray(params)
        ? Object.keys(params!)
            .sort()
            .reduce((sortedParams: any, k) => {
              sortedParams[k] = (params as any)[k];
              return sortedParams;
            }, {})
        : params,
    );

  const { app, instances, initialState } = context;

  const instance: ModelInstance<Name, Params, Data, App, Effects> | undefined =
    instances[key];
  if (instance) {
    return instance;
  }

  const { subscribe, notify } = createSubscription();
  let usingCounter = 0;

  let state: ModelState<Data> = initialState[key]!;
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

  let effectsQueue: Promise<void> | void;
  let effectsQueueLength = 0;

  const processEffect = async (effect: ModelEffect<Data>) => {
    const { isPending, data, error } = state;
    try {
      const result = effect();

      if (result instanceof Promise) {
        if (!isPending) {
          setState({ isPending: true, data, error });
        }
        const newData = await result;

        if (newData !== data || effectsQueueLength === 0) {
          setState({
            isPending: effectsQueueLength > 0,
            data: newData,
          });
        }
      } else if (result !== data || (isPending && effectsQueueLength === 0)) {
        setState({
          isPending: isPending && effectsQueueLength > 0,
          data: result,
        });
      }
    } catch (error) {
      setState({
        isPending: effectsQueueLength > 0,
        data,
        error,
      });
    }
  };

  const queueEffect = (effect: () => Promise<void> | void) => {
    if (effectsQueue) {
      effectsQueueLength++;
      effectsQueue = effectsQueue
        .then(() => {
          effectsQueueLength--;
          return effect();
        })
        .then(() => {
          if (effectsQueueLength === 0) {
            effectsQueue = undefined;
          }
        });
    } else {
      effectsQueue = effect();
    }
  };

  const normalize = <D>(s: ModelSelection<any, any, D, App, any>, d: D) =>
    s(context)._normalize(d);

  const effects = effectKeys.reduce((acc, k: keyof Effects) => {
    acc[k] = (...args) => {
      queueEffect(async () => {
        let detachedEffects: Array<ModelEffect<Data>> = [];

        let isInEffect = true;

        await processEffect(() =>
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

        let effect;
        while ((effect = detachedEffects.shift())) {
          await processEffect(effect);
        }

        isInEffect = false;
      });
    };
    return acc;
  }, {} as { [K in keyof Effects]: (...args: any) => void });

  const willReady = async () => {
    do {
      await effectsQueue;
    } while (effectsQueueLength);
  };

  let clearDataTimeoutId: NodeJS.Timeout | undefined;

  const clearData = ({ delay = 15000 }: { delay?: number } = {}) => {
    Promise.all([
      willReady(),
      new Promise((resolve) => {
        clearDataTimeoutId = setTimeout(() => resolve, delay);
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
        }
      };
    },

    effects: effects as any,

    _normalize(data: Data) {
      queueEffect(() => processEffect(() => data));
    },

    _willReady: willReady,
  });
}

type Dict<T> = { [id: string]: T | undefined };

export type Model<
  Name extends string,
  Params,
  Data,
  App,
  Effects extends { [x: string]: (...args: any) => any }
> = (params: Params) => ModelSelection<Name, Params, Data, App, Effects>;

export interface ModelSelection<
  Name extends string,
  Params,
  Data,
  App,
  Effects extends { [x: string]: (...args: any) => any }
> {
  (context: Context<App>): ModelInstance<Name, Params, Data, App, Effects>;
  effects: {
    [K in keyof Effects]: (
      ...args: Parameters<Effects[K]>
    ) => (context: Context<App>) => void;
  };
}

export type ModelInstance<
  _Name extends string,
  _Params,
  Data,
  _App,
  Effects extends { [x: string]: (...args: any) => any }
> = {
  getState: () => ModelState<Data>;
  subscribe: (listener: () => any) => () => void;
  effects: {
    [K in keyof Effects]: (...args: Parameters<Effects[K]>) => void;
  };
  _normalize: (data: Data) => void;
  _willReady: () => Promise<void>;
};

export type ModelState<Data> = { data?: Data; error?: any; isPending: boolean };

export type ModelDispatch<App> = <T>(action: (context: Context<App>) => T) => T;

export type ModelLive<
  Params,
  Data,
  App,
  Effects extends { [x: string]: (...args: any) => any }
> = (
  effects: {
    [K in keyof Effects]: (...args: Parameters<Effects[K]>) => void;
  },
  params: Params,
  app: App,
  access: {
    getState: () => ModelState<Data>;
    subscribe: (listener: () => any) => () => void;
  },
) => ModelDie | undefined | void;

export type ModelEffectsConfig<Params, Data, App, Effects> = (
  app: App,
  params: Params,
  data: Data | undefined,
  tools: ModelTools<Data, App>,
) => Effects;

export type ModelDie = (tools: {
  clearData: (opts?: { delay?: number }) => void;
}) => any;

type ModelEffect<Data> = () => Promise<Data | undefined> | Data | undefined;

export interface ModelTools<Data, App> {
  normalize: <D>(
    modelSelection: ModelSelection<any, any, D, App, any>,
    data: D,
  ) => void;
  detachEffect: (effect: () => Promise<Data | undefined>) => void;
}

type GetDataFromEffects<Effects> = Effects extends {
  [x: string]: (
    ...args: any
  ) => Promise<infer D | undefined> | infer D | undefined;
}
  ? D
  : unknown;
