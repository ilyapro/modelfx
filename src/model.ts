import { createSubscription } from './subscription';

// tslint:disable no-object-mutation

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
        data: D
      ) => void;
    }
  ) => Effects,
  live: (
    effects: { [K in keyof Effects]: (...args: Parameters<Effects[K]>) => void }
  ) => ModelDie | undefined
): Model<
  Name,
  Params,
  GetDataFromEffects<Effects>,
  Application,
  { [K in keyof Effects]: (...args: Parameters<Effects[K]>) => void }
> {
  if (idExistance[name]) {
    if (process.env.NODE_ENV === 'development') {
      // tslint:disable-next-line no-console
      console.error(
        `Trying to create a model with a pre-existing name ${name}`
      );
    }
    name = Math.random().toString() as Name; // tslint:disable-line no-parameter-reassignment
  }
  idExistance[name] = true;

  return (params: Params) => {
    const getInstance = (context: any) =>
      createModelInstance(name, context, params, effects, live);

    return {
      _getInstance: getInstance as any,

      getState: () => context => getInstance(context).getState() as any,

      subscribe: listener => context =>
        getInstance(context).subscribe(listener),

      effects: Object.keys(
        effects({} as any, params, {} as any, {} as any) || {}
      ).reduce((acc, k) => {
        acc[k] = (...args: any) => (context: any) =>
          getInstance(context).effects[k](...args);
        return acc;
      }, {} as any),
    };
  };
}

interface ModelContext<Application> {
  data: Dict<Dict<ModelState<any>>>;
  instances: Dict<Dict<ModelInstance<any, any, any, Application, any>>>;
  application: Application;
}
export function createModelContext<Application>(
  application: Application,
  initialData?: ModelContext<Application>['data']
) {
  const context = {
    data: initialData || {},
    instances: {},
    application,
  };
  return {
    dispatch: getDispatch(context),
    getData: () => context.data,
  };
}

function createModelInstance<
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
        data: D
      ) => void;
    }
  ) => Effects,
  live: (
    effects: { [K in keyof Effects]: (...args: Parameters<Effects[K]>) => void }
  ) => ModelDie | undefined
): ModelInstance<Name, Params, Data, Application, Effects> {
  const key = JSON.stringify(
    typeof params === 'object' && !Array.isArray(params)
      ? Object.keys(params)
          .sort()
          .reduce((sortedParams: any, k) => {
            sortedParams[k] = (params as any)[k];
            return sortedParams;
          }, {})
      : params
  );

  const instances = context.instances[name] || (context.instances[name] = {});
  const instance:
    | ModelInstance<Name, Params, Data, Application, Effects>
    | undefined = instances[key];
  if (instance) {
    return instance;
  }

  const { subscribe, notify } = createSubscription();
  let usingCounter = 0;

  const states = context.data[name] || (context.data[name] = {});
  let state: ModelState<Data> =
    states[key] || (states[key] = { isPending: false });

  const setState = (newState: ModelState<Data>) => {
    states[key] = state = newState;
    notify();
  };

  const clearData = ({ delay = 3000 }: { delay?: number } = {}) => {
    setTimeout(() => {
      if (usingCounter) {
        return;
      }

      delete context.instances[name]![key];
      delete context.data[name]![key];

      if (Object.keys(context.instances[name]!).length === 0) {
        delete context.instances[name];
        delete context.data[name];
      }
    }, delay);
  };
  let die: ModelDie | undefined;

  let effectsQueue = Promise.resolve();

  const tools = {
    normalize: <D>(s: ModelSelection<any, any, D, Application, any>, d: D) => {
      s._getInstance(context).setState({ isPending: false, data: d });
    },
  };

  const effects = {} as ModelInstance<
    Name,
    Params,
    Data,
    Application,
    Effects
  >['effects'];

  Object.keys(
    effectsConfig(context.application, params, undefined, tools)
  ).forEach((k: keyof Effects) => {
    effects[k] = (...args: any) => {
      effectsQueue = effectsQueue.then(async () => {
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
      });
    };
  });

  return (instances[key] = {
    getState: () => state,
    setState,

    subscribe: (listener: () => any) => {
      if (usingCounter++ === 0) {
        if (live) {
          die = live(effects);
        }
      }

      const unsubscribe = subscribe(listener);

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
  });
}

function getDispatch<Application>(
  context: ModelContext<Application>
): ModelDispatch<Application> {
  return action => action(context);
}

/**
 * Вспомогательные типы
 */
type Dict<T> = { [id: string]: T | undefined };

type Model<
  Name extends string,
  Params,
  Data,
  Application,
  Effects extends { [x: string]: (...args: any) => any }
> = (
  params: Params
) => ModelSelection<Name, Params, Data, Application, Effects>;

type ModelSelection<
  Name extends string,
  Params,
  Data,
  Application,
  Effects extends { [x: string]: (...args: any) => any }
> = {
  _getInstance: (
    context: ModelContext<Application>
  ) => ModelInstance<Name, Params, Data, Application, Effects>;
  getState: () => (context: ModelContext<Application>) => ModelState<Data>;
  subscribe: (
    listener: () => any
  ) => (context: ModelContext<Application>) => () => any;
  effects: {
    [K in keyof Effects]: (
      ...args: Parameters<Effects[K]>
    ) => (context: ModelContext<Application>) => void;
  };
};

type ModelInstance<
  _Name extends string,
  _Params,
  Data,
  _Application,
  Effects extends { [x: string]: (...args: any) => any }
> = {
  getState: () => ModelState<Data>;
  setState: (newState: ModelState<Data>) => void;
  subscribe: (listener: () => any) => () => void;
  effects: {
    [K in keyof Effects]: (...args: Parameters<Effects[K]>) => void;
  };
};

type ModelState<Data> = { data?: Data; error?: {}; isPending: boolean };

type ModelDispatch<Application> = <T>(
  action: (context: ModelContext<Application>) => T
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
