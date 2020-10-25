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
    tools: {
      normalize: <D>(
        modelSelection: ModelSelection<any, any, D, Application, any>,
        data: D,
      ) => void;
    },
  ) => Effects,
  live: (
    effects: {
      [K in keyof Effects]: (...args: Parameters<Effects[K]>) => Promise<void>;
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
  state: Dict<Dict<ModelState<any>>>;
  instances: Dict<Dict<ModelInstance<any, any, any, Application, any>>>;
  application: Application;
}
export interface ModelContextApi<Application> {
  dispatch: ModelDispatch<Application>;
  getAllState: () => ModelContext<Application>['state'];
}
export function createModelContext<Application>(
  application: Application,
  initialState?: ModelContext<Application>['state'],
): ModelContextApi<Application> {
  const instances: ModelContext<Application>['instances'] = {};
  const context = {
    state: initialState || {},
    instances,
    application,
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
    tools: {
      normalize: <D>(
        modelSelection: ModelSelection<any, any, D, Application, any>,
        data: D,
      ) => void;
    },
  ) => Effects,
  effectKeys: Array<keyof Effects>,
  live: (
    effects: {
      [K in keyof Effects]: (...args: Parameters<Effects[K]>) => Promise<void>;
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

  const { instances: contextInstances, state: contextState } = context;

  const instances = contextInstances[name] || (contextInstances[name] = {});
  const instance:
    | ModelInstance<Name, Params, Data, Application, Effects>
    | undefined = instances[key];
  if (instance) {
    return instance;
  }

  const { subscribe, notify } = createSubscription();
  let usingCounter = 0;

  const states = contextState[name];
  let state: ModelState<Data> = states?.[key]!;
  if (state) {
    delete states![key];
    if (Object.keys(states!).length === 0) {
      delete contextState[name];
    }
  } else {
    state = { isPending: false };
  }

  const setState = (newState: ModelState<Data>) => {
    state = newState;
    notify();
  };

  const clearData = ({ delay = 3000 }: { delay?: number } = {}) => {
    setTimeout(() => {
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

  let effectsQueue = Promise.resolve();

  const tools = {
    normalize: <D>(s: ModelSelection<any, any, D, Application, any>, d: D) =>
      s(context)._normalize(d),
  };

  const effects = {} as ModelInstance<
    Name,
    Params,
    Data,
    Application,
    Effects
  >['effects'];

  effectKeys.forEach((k: keyof Effects) => {
    effects[k] = (...args: any) =>
      (effectsQueue = effectsQueue.then(async () => {
        let { data, error } = state;

        setState({ isPending: true, data, error });
        try {
          data = await effectsConfig(context.application, params, data, tools)[
            k
          ](...args);
        } catch (e) {
          error = e;
        }
        setState({ isPending: false, data, error });
      }));
  });

  return (instances[key] = {
    getState: () => state,

    subscribe: (listener: () => any) => {
      const unsubscribe = subscribe(listener);

      if (usingCounter++ === 0) {
        if (live) {
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

    _normalize: (data: Data) =>
      (effectsQueue = effectsQueue.then(() => {
        setState({ isPending: false, data });
      })),
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
    ) => (context: ModelContext<Application>) => Promise<void>;
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
    [K in keyof Effects]: (...args: Parameters<Effects[K]>) => Promise<void>;
  };
  _normalize: (data: Data) => Promise<void>;
};

export type ModelState<Data> = { data?: Data; error?: any; isPending: boolean };

export type ModelDispatch<Application> = <T>(
  action: (context: ModelContext<Application>) => T,
) => T;

type ModelDie = (tools: {
  clearData: (opts?: { delay?: number }) => void;
}) => any;

type GetDataFromEffects<Effects> = Effects extends {
  [x: string]: (
    ...args: any
  ) => Promise<infer D | undefined> | infer D | undefined;
}
  ? D
  : unknown;
