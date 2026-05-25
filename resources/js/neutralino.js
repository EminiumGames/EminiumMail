;(function () {
  if (window.Neutralino) {
    return
  }

  const unavailable = async () => ({
    pid: 0,
    stdOut: '',
    stdErr: 'Neutralino runtime unavailable in this preview mode.',
    exitCode: 1
  })

  window.Neutralino = {
    init: async () => undefined,
    os: {
      execCommand: unavailable,
      spawnProcess: async () => ({ id: 0, pid: 0 }),
      updateSpawnedProcess: async () => undefined,
      getPath: async () => '',
      showNotification: async () => undefined,
      open: async () => undefined
    },
    app: {
      exit: async () => undefined
    },
    events: {
      on: () => undefined,
      off: () => undefined
    },
    storage: {
      getData: async () => null,
      setData: async () => undefined
    }
  }
})()
