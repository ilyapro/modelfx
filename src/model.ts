import { createSubscription } from './subscription';

const idExistance: Dict<true> = {};

export function createModel<
  Name extends string,
  Params,
  Data,
  Application,
  Effects extends {
    [x: string]: (...args: any) => Promise<Data | undefined> | Data | undefined;
  }
>(
  name: Name,
  effects: (
    app: Application,
    params: Params,
    data: Data | undefined,
    tools: ModelTools<Data, Application>,
  ) => Effects,
  live: (
    effects: {
      [K in keyof Effects]: (...args: Parameters<Effects[K]>) => void;
    },
    params: Params,
  ) => ModelDie | undefined | void,
): Model<
  Name,
  Params,
  GetDataFromEffects<Effects>,
  Application,
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
    const modelSelection = (context: ModelContext<Application>) =>
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

interface ModelContext<Application> {
  initialState: Dict<Dict<ModelState<any>>>;
  instances: Dict<Dict<ModelInstance<any, any, any, Application, any>>>;
  application: Application;
}
export interface ModelContextApi<Application> {
  dispatch: ModelDispatch<Application>;
  getAllState: () => ModelContext<Application>['initialState'];
}
export function createModelContext<Application>(
  application: Application,
  initialState: ModelContext<Application>['initialState'] = {},
): ModelContextApi<Application> {
  const instances: ModelContext<Application>['instances'] = {};
  const context = {
    application,
    initialState,
    instances,
  };
  return {
    dispatch: (action) => action(context),
    getAllState: () => {
      return Object.keys(instances).reduce((state, name) => {
        const instancesByName = instances[name]!;

        state[name] = Object.keys(instancesByName).reduce(
          (stateByName, key) => {
            stateByName[key] = instancesByName[key]!.getState();
            return stateByName;
          },
          {} as Dict<ModelState<any>>,
        );

        return state;
      }, {} as Dict<Dict<ModelState<any>>>);
    },
  };
}

function getInstance<
  Name extends string,
  Params,
  Data,
  Application,
  Effects extends { [x: string]: (...args: any) => any }
>(
  name: string,
  context: ModelContext<Application>,
  params: Params,
  effectsConfig: (
    app: Application,
    params: Params,
    data: Data | undefined,
    tools: ModelTools<Data, Application>,
  ) => Effects,
  effectKeys: Array<keyof Effects>,
  live: (
    effects: {
      [K in keyof Effects]: (...args: Parameters<Effects[K]>) => void;
    },
    params: Params,
  ) => ModelDie | undefined | void,
): ModelInstance<Name, Params, Data, Application, Effects> {
  const key = JSON.stringify(
    typeof params === 'object' && !Array.isArray(params)
      ? Object.keys(params!)
          .sort()
          .reduce((sortedParams: any, k) => {
            sortedParams[k] = (params as any)[k];
            return sortedParams;
          }, {})
      : params,
  );

  const { instances: contextInstances, initialState } = context;

  const instances = contextInstances[name] || (contextInstances[name] = {});
  const instance:
    | ModelInstance<Name, Params, Data, Application, Effects>
    | undefined = instances[key];
  if (instance) {
    return instance;
  }

  const { subscribe, notify } = createSubscription();
  let usingCounter = 0;

  const states = initialState[name];
  let state: ModelState<Data> = states?.[key]!;
  if (state) {
    delete states![key];
    if (Object.keys(states!).length === 0) {
      delete initialState[name];
    }
  } else {
    state = { isPending: false };
  }

  const setState = (newState: ModelState<Data>) => {
    state = newState;
    setTimeout(notify, 0);
  };

  let clearDataTimeoutId: NodeJS.Timeout | undefined;

  const clearData = ({ delay = 3000 }: { delay?: number } = {}) => {
    clearDataTimeoutId = setTimeout(() => {
      if (usingCounter) {
        return;
      }
      delete contextInstances[name]![key];
      if (Object.keys(contextInstances[name]!).length === 0) {
        delete contextInstances[name];
      }
    }, delay);
  };
  let die: ModelDie | undefined | void;

  let effectsQueue: Array<ModelEffect<Data>> = [];
  let areEffectsRunning = false;

  const processEffect = async (effect: ModelEffect<Data>) => {
    const { isPending, data, error } = state;
    try {
      const result = effect();

      if (result instanceof Promise) {
        if (!isPending) {
          setState({ isPending: true, data, error });
        }
        setState({
          isPending: effectsQueue.length > 0,
          data: await result,
        });
      } else {
        setState({
          isPending: isPending && effectsQueue.length > 0,
          data: result,
        });
      }
    } catch (error) {
      setState({
        isPending: effectsQueue.length > 0,
        data,
        error,
      });
    }
  };

  const queueEffect = async (effect: ModelEffect<Data>) => {
    if (areEffectsRunning) {
      effectsQueue.push(effect);
    } else {
      areEffectsRunning = true;
      do {
        await processEffect(effect);
      } while ((effect = effectsQueue.shift()!));

      areEffectsRunning = false;
    }
  };

  const normalize = <D>(
    s: ModelSelection<any, any, D, Application, any>,
    d: D,
  ) => s(context)._normalize(d);

  const effects = {} as ModelInstance<
    Name,
    Params,
    Data,
    Application,
    Effects
  >['effects'];

  effectKeys.forEach((k: keyof Effects) => {
    effects[k] = (...args: any) => {
      queueEffect(() => {
        let detachedEffects: Array<ModelEffect<Data>> = [];

        let isInEffect = true;

        const result = effectsConfig(context.application, params, state.data, {
          normalize,
          detachEffect: (effect) => {
            if (isInEffect) {
              detachedEffects.unshift(effect);
            } else {
              effectsQueue.push(effect);
            }
          },
        })[k](...args);

        isInEffect = false;

        detachedEffects.forEach((effect) => {
          effectsQueue.unshift(effect);
        });

        return result;
      });
    };
  });

  return (instances[key] = {
    getState: () => state,

    subscribe: (listener: () => any) => {
      const unsubscribe = subscribe(listener);

      if (usingCounter++ === 0) {
        if (live) {
          if (clearDataTimeoutId) {
            clearTimeout(clearDataTimeoutId);
          }
          die = live(effects, params);
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
      queueEffect(() => data);
    },
  });
}

type Dict<T> = { [id: string]: T | undefined };

export type Model<
  Name extends string,
  Params,
  Data,
  Application,
  Effects extends { [x: string]: (...args: any) => any }
> = (
  params: Params,
) => ModelSelection<Name, Params, Data, Application, Effects>;

export interface ModelSelection<
  Name extends string,
  Params,
  Data,
  Application,
  Effects extends { [x: string]: (...args: any) => any }
> {
  (context: ModelContext<Application>): ModelInstance<
    Name,
    Params,
    Data,
    Application,
    Effects
  >;
  effects: {
    [K in keyof Effects]: (
      ...args: Parameters<Effects[K]>
    ) => (context: ModelContext<Application>) => void;
  };
}

export type ModelInstance<
  _Name extends string,
  _Params,
  Data,
  _Application,
  Effects extends { [x: string]: (...args: any) => any }
> = {
  getState: () => ModelState<Data>;
  subscribe: (listener: () => any) => () => void;
  effects: {
    [K in keyof Effects]: (...args: Parameters<Effects[K]>) => void;
  };
  _normalize: (data: Data) => void;
};

export type ModelState<Data> = { data?: Data; error?: any; isPending: boolean };

export type ModelDispatch<Application> = <T>(
  action: (context: ModelContext<Application>) => T,
) => T;

type ModelDie = (tools: {
  clearData: (opts?: { delay?: number }) => void;
}) => any;

type ModelEffect<Data> = () => Promise<Data | undefined> | Data | undefined;

interface ModelTools<Data, Application> {
  normalize: <D>(
    modelSelection: ModelSelection<any, any, D, Application, any>,
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
