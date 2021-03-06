# modelfx

JS(TS) library for decomposited dataflow control in web applications. Can act as M in MVC pattern.
Provides the creation of models that are shared components of storage and effects of some data.

```
npm i modelfx
```

- [Model context](#model-context)
- [Model](#model)
- [How to use models](#how-to-use-models)
- [How to use with React](#how-to-use-with-react)
- [SSR](#ssr)
- [Normalize data](#normalize-data)
- [Optimistic updates](#optimistic-updates)

## Model context

Models are using in context.  
Contexts are isolated, so data of same model in different contexts are diffrent objects.  
Also, model context can hold some application context to use in model effects.

```javascript
import { createModelContext } from 'modelfx';

const applicationContextThings = {
  config,
  request,
  ...orEverythingYouWant,
};
const modelContext = createModelContext(applicationContextThings);
```

## Model

Model is component of storage and effects of some data.  
You name the model, describe the effects and live.

```javascript
import { createModel } from 'modelfx';

const todoList = createModel(
  // Model Name. That used as unique namespace for storing model things
  'todoList',

  // Model Effects. That produce some external asynchronously work and replace model data.
  // Subscribers will be notified when model setted to pending and when new data is returned.
  (
    // Your things from context creation
    app,
    // Parameters that defines model instance, when you will use model todoList({ user: 'snapdog' })
    params,
    // Actual data of model in current moment
    data,
    // System tools for some features
    tools,
  ) => ({
    async fulfill() {
      return data || (await app.request(`todo/list?user=${params.user}`));
    },

    async update() {
      return await app.request(`todo/list?user=${params.user}`);
    },

    justSetData(data) {
      // Promise is not required
      return data;
    },
  }),

  // Model Live. That happens when model got a first subscriber
  (effects, params, app, { getState, subscribe }) => {
    effects.fulfill();

    // You can refresh your data from backend
    const refreshIntervalId = setInterval(() => {
      effects.update();
    }, 5000);

    // Or interact with other events
    const storageHandler = (event) => {
      effects.justSetData(event.newValue);
    };
    window.addEventListener('storage', storageHandler);

    // Or handle each state change with the subscribe.
    // Internal subscription does not affect the model's death, which occurs when all external subscribers unsubscribe.
    const socket = createSocket().connect('remotetodolist:5111');
    socket.on('connect', () => {
      const unsubscribe = subscribe(() => {
        socket.send(getState());
      });
      socket.on('disconnect', unsubscribe);
    });

    // Model Die. That happens when last external subscriber unsubscribes.
    return ({ clearData }) => {
      clearInterval(refreshIntervalId);
      window.removeEventListener('storage', storageHandler);
      socket.disconnect();

      // You can clear model data. Otherwise, it will be cached in model context.
      // After delay, the data will be cleared if no one will subscribed to the model
      clearData({ delay: 180000 /* ms, default 15000 */ });
    };
  },
);
```

## How to use models

If you imagine model as a data table, then you will select data of rows in it.  
Each row is a model instance that you will access by specifying parameters. In other words, model params are key to the instance (to the "row in the table").  
When you access the instance, it is instantiated once and lives as long as it has subscribers and will be reused between all calls in the same model context.

```javascript
const modelContext = createModelContext({ request });

// Call the instance of todoList
const snapdogTodoList = modelContext.dispatch(todoList({ user: 'snapdog' }));

// First subscribe executes model's live. That will fulfill and refresh data, that cause repainting "container" with new todoList
const unsubscribe = snapdogTodoList.subscribe(() => {
  const { data, error, isPending } = snapdogTodoList.getState();

  let content = 'empty';
  if (isPending) {
    content = 'loading';
  } else if (error) {
    content = JSON.stringify(error);
  } else if (data) {
    content = JSON.stringify(data);
  }
  document.getElementById('container').innerText = content;
});

// Also you can dispatch effects
window.addEventListener('focus', () => {
  modelContext.dispatch(todoList({ user: 'snapdog' }).effects.update());
  // or simillar
  snapdogTodoList.effects.update();
});

setTimeout(() => {
  // Last unsubscribe calls model to die. That will clear data
  unsubscribe();
}, 300000);
```

## How to use with React

You can create universal model hook.
This hook gives ease way to use model state in react components and causes components to be updated when effects are executed.

```javascript
export function useModel(selection) {
  const context = React.useContext(ReactModelContext);
  const instance = context.dispatch(selection);
  const [state, setState] = React.useState(instance.getState());

  React.useEffect(() => {
    setState(instance.getState());

    return instance.subscribe(() => {
      setState(instance.getState());
    });
  }, [instance]);

  return state;
}
```

Setup context

```javascript
const ReactModelContext = React.createContext();
const modelContext = createModelContext({...});

return (
  <ReactModelContext.Provider value={modelContext}>
    <MainContainer />
  </ReactModelContext.Provider>
);
```

Now you can use any models easy in react components.

```javascript
function MainContainer() {
  const userName = useModel(user()).data?.name;
  const snapdogTodoListState = useModel(todoList({ user: userName || '' }));

  const firstTodoItemId = snapdogTodoListState.data?.[0].id;

  const { dispatch } = useContext(ReactModelContext);
  const editFirstItem = useCallback(() => {
    if (!firstTodoItemId) {
      return;
    }
    dispatch(todoItem({ id: firstTodoItemId }).effects.edit('new data'));
  }, [firstTodoItemId]);

  if (snapdogTodoListState.isPending) {
    return <div>loading</div>;
  }

  if (snapdogTodoListState.error) {
    return <div>{snapdogTodoList.error}</div>;
  }

  return <div onClick={editFirstItem}>{snapdogTodoListState.data}</div>;
}
```

## SSR

You can fulfill models on server side and you will already have data in models on client side.  
To do this, you should send data in html.

server.js

```javascript
const modelContext = createModelContext({...});

modelContext.dispatch(todoList({ user: 'snapdog' }).effects.fulfill());

await modelContext.willAllReady();

response.send(`
  <html>
  ...
  <script>
    window.MODEL_STATE = ${JSON.stringify(modelContext.getAllState())};
  </script>
  ...
  </html>
`);
```

client.js

```javascript
const modelContext = createModelContext(applicationContextThings, window.MODEL_STATE);
...
```

Now, you can use models in this context, and it is fulfilled already

## Normalize data

If you want to normalize todoList data in two models (list and item), you can do it with `tools.normalize`

```javascript
const todoList = createModel(
  'todoList',
  (app, params, data, tools) => ({
    async fulfill() {
      list = await app.request(`todo/list?user=${params.user}`);

      const ids = list.map((item) => {
        tools.normalize(todoItem({ id: item.id }), item);
        return item.id;
      });
      return ids;
    },
  }),
  () => {},
);

const todoItem = createModel(
  'todoItem',
  () => ({}),
  () => {},
);
```

The todoList now only stores a list of IDs, and the data for each item is stored in todoItem.

```javascript
const ids = dispatch(todoList({ user: 'snapdog' })).getState().data;
const items = ids.map((id) => dispatch(todoItem({ id })).getState().data);
```

## Optimistic updates

If you want to update data immediately, you could try something like synchronous effect.
This will indeed lead to an immediate update, but in case of a request error, it will not be handled.

```javascript
const todoItem = createModel(
  'todoItem',

  (app, params, data, tools) => ({
    edit(newData) {
      app.request(`todo/item?id=${params.id}`, { post: newData }),
      return newData;
    },
  }),

  () => {},
);
```

So there is `tools.detachEffect`. This will cause the request to be executed after the end of the effect call and the `todoItem` will be additionally updated with the result.

```javascript
const todoItem = createModel(
  'todoItem',

  (app, params, data, tools) => ({
    edit(newData) {
      tools.detachEffect(() =>
        app.request(`todo/item?id=${params.id}`, { post: newData }),
      );
      return newData;
    },
  }),

  () => {},
);
```
