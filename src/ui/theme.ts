export function palette(theme: 'dark' | 'light') {
  return theme === 'light'
    ? {
        accent: '#007c56',
        muted: '#61727c',
        border: '#b7c9ce',
        text: '#183038',
        highlight: '#cbe9dc',
        incoming: '#e9eff2',
        outgoing: '#d6f0e2',
        badgeText: '#ffffff',
        read: '#1c6aa8',
      }
    : {
        accent: '#35deb0',
        muted: '#8499a9',
        border: '#304551',
        text: '#e5edf3',
        highlight: '#244b40',
        incoming: '#172630',
        outgoing: '#143b30',
        badgeText: '#07261e',
        read: '#69bef0',
      };
}
