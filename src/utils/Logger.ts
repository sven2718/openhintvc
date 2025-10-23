import * as log4js from 'log4js';

// Configure log4js v6 style
log4js.configure({
  appenders: {
    out: { type: 'stdout' }
  },
  categories: {
    default: { appenders: ['out'], level: 'trace' }
  }
});

export default log4js;
