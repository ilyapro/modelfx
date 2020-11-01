export function createKey(params: any): string {
  switch (typeof params) {
    case 'undefined': {
      return 'u';
    }

    case 'string': {
      return `s${params.replace(/|/g, '|d')}`;
    }

    case 'object': {
      if (Array.isArray(params)) {
        return `a${params.map(createKey).join('|')}`;
      }

      if (params === null) {
        return 'n';
      }

      return `o${Object.keys(params)
        .sort()
        .reduce((acc, key) => {
          const value = params[key];
          if (value !== undefined) {
            acc.push(`${key}:${createKey(value)}`);
          }
          return acc;
        }, [] as string[])
        .join('|')}`;
    }

    default: {
      return String(params);
    }
  }
}
