import { Subscription } from './subscription';

export interface ModelContext<App> {
  dispatch: ModelDispatch<App>;
  getAllState: () => Context<App>['initialState'];
  willAllReady: () => Promise<void>;
  getDebugger: () => ModelDebugger;
}

export type ModelDebugger = {
  listenToAllEvents: (listener: (event: ModelDebugEvent) => void) => () => void;
};

export type ModelDebugEvent =
  | GetDebugEvent<'live'>
  | GetDebugEvent<'die'>
  | GetDebugEvent<'clearData'>
  | GetDebugEvent<'effectStart', { effect: ModelDebugEventEffect }>
  | GetDebugEvent<'effectSuccess', { effect: ModelDebugEventEffect }>
  | GetDebugEvent<'effectError', { effect: ModelDebugEventEffect }>
  | GetDebugEvent<'detachSuccess', { effect: ModelDebugEventEffect }>
  | GetDebugEvent<'detachError', { effect: ModelDebugEventEffect }>
  | GetDebugEvent<'syncEffectSuccess', { effect: ModelDebugEventEffect }>
  | GetDebugEvent<'syncEffectError', { effect: ModelDebugEventEffect }>
  | GetDebugEvent<'normalize'>;

type GetDebugEvent<Type extends string, Adds extends {} = {}> = {
  type: Type;
  model: { name: string; params: any; state: ModelState<any> };
} & Adds;

export type ModelDebugEventEffect = { name: string; args: any[] };

export type Model<
  Name extends string,
  Params,
  Data,
  App,
  Effects extends Dict<ModelEffect>
> = (params: Params) => ModelSelection<Name, Params, Data, App, Effects>;

export interface ModelSelection<
  Name extends string,
  Params,
  Data,
  App,
  Effects extends Dict<ModelEffect>
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
  Effects extends Dict<ModelEffect>
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

export type ModelLive<Params, Data, App, Effects extends Dict<ModelEffect>> = (
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

export type ModelEffect<Data = any, Args extends [] = any> = (
  ...args: Args
) => Promise<Data | undefined> | Data | undefined;

export interface ModelTools<Data, App> {
  normalize: <D>(
    modelSelection: ModelSelection<any, any, D, App, any>,
    data: D,
  ) => void;
  detachEffect: (effect: () => Promise<Data | undefined>) => void;
}

export type Dict<T> = { [x: string]: T };

export type Context<App> = {
  initialState: Dict<ModelState<any>>;
  instances: Dict<ModelInstance<any, any, any, App, any>>;
  app: App;
  debug?: {
    emitEvent: Subscription<[ModelDebugEvent]>['notify'];
  };
};
