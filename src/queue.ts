export function createQueue() {
  let queue: Promise<void> | void;
  let length = 0;

  return {
    isEmpty: () => length === 0,

    add(fn: () => Promise<void> | void) {
      if (queue) {
        length++;

        queue = queue
          .then(() => {
            length--;

            return fn();
          })
          .then(() => {
            if (length === 0) {
              queue = undefined;
            }
          });
      } else {
        queue = fn();
      }
    },

    async willReady() {
      do {
        await queue;
      } while (length);
    },
  };
}
