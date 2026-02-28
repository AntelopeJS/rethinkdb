module.exports.setup = async function () {
  return {
    cacheFolder: '.antelope/cache',
    modules: {
      local: {
        source: {
          type: 'local',
          path: '.',
        },
        config: {
          pool: {
            pool: true,
            cursor: false,
            silent: true,
            user: 'admin',
            password: '',
            discovery: false,
            host: '127.0.0.1',
            port: 28015,
          },
        },
      },
    },
  };
};

module.exports.cleanup = async function () {};
