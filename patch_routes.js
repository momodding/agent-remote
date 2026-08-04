const fs = require('fs');
let code = fs.readFileSync('client/app/terminal/[id].tsx', 'utf8');

// 1. Add multiSocketsRef and isMultiMode at top of component
code = code.replace(
  'const socket = useRef<SessionSocket | undefined>(undefined);',
  'const socket = useRef<SessionSocket | undefined>(undefined);\n  const isMultiModeCheck = mode === "multi";\n  const multiSocketsRef = useRef<Record<string, SessionSocket>>({});'
);

// 2. Change legacy connect initialization
code = code.replace(
  'connect(resolved);',
  'if (!isMultiModeCheck) connect(resolved);'
);

// 3. Fix useEffect hooks
code = code.replace(
  '], [connect, connectionEndpoint]);',
  '], [connect, connectionEndpoint, isMultiModeCheck]);'
);
code = code.replace(
  '], [connection, connect]);',
  '], [connection, connect, isMultiModeCheck]);'
);

// 4. Update the unmount return
code = code.replace(
  'socket.current?.close();\n    };\n  }, [connect, connectionEndpoint, isMultiModeCheck]);',
  'socket.current?.close();\n      Object.values(multiSocketsRef.current).forEach((s) => s.close());\n      multiSocketsRef.current = {};\n    };\n  }, [connect, connectionEndpoint, isMultiModeCheck]);'
);

// 5. Update AppState hook
code = code.replace(
  'if (state !== \'active\') socket.current?.close();',
  'if (state === \'active\' && connection) {\n        if (!isMultiModeCheck) connect(connection);\n        Object.values(multiSocketsRef.current).forEach((s) => s.connect());\n      } else if (state === \'background\') {\n        socket.current?.close();\n        Object.values(multiSocketsRef.current).forEach((s) => s.close());\n      }'
);

// 6. Fix detach
code = code.replace(
  'const detach = useCallback(() => {\n    socket.current?.close();\n    router.replace(\'/\');\n  }, []);',
  'const detach = useCallback(() => {\n    socket.current?.close();\n    Object.values(multiSocketsRef.current).forEach((s) => s.close());\n    multiSocketsRef.current = {};\n    router.replace(\'/\');\n  }, []);'
);

// 7. Inject handleCloseAll and rewrite handleAddSession / handleCloseSession / Input
code = code.replace(
  'const handleAddSession = useCallback((sessionId: string, sessionName: string) => {\n    const newSession: MultiSessionState = {\n      sessionId,\n      name: sessionName,\n      connectionEndpoint: connection.endpoint,\n      output: \'\',\n      minimized: false,\n    };\n    if (connection) {\n      const sock = new SessionSocket(\n        connection,\n        sessionId,\n        (data) => setMultiSessions((prev) => updateOutput(prev, sessionId, prev[sessionId]?.output + data)),\n        (state) => {\n          if (state === \'exited\') {\n            setMultiSessions((prev) => closeSession(prev, sessionId));\n          }\n        },\n        (message) => Alert.alert(\'Terminal\', message),\n      );\n      sock.connect();\n      newSession.socket = sock;\n    }\n    setMultiSessions((prev) => addSession(prev, newSession));\n  }, [connection]);',
  `const handleAddSession = useCallback((sessionId: string, sessionName: string) => {
    if (!connection || multiSocketsRef.current[sessionId]) return;
    const newSession: MultiSessionState = {
      sessionId,
      name: sessionName,
      connectionEndpoint: connection.endpoint,
      output: '',
      minimized: false,
    };
    const newSocket = new SessionSocket(
      connection,
      sessionId,
      (data) => setMultiSessions((prev) => updateOutput(prev, sessionId, prev[sessionId]?.output + data)),
      (state) => {
        if (state === 'exited') {
          multiSocketsRef.current[sessionId]?.close();
          delete multiSocketsRef.current[sessionId];
          setMultiSessions((prev) => closeSession(prev, sessionId));
        }
      },
      (message) => Alert.alert('Terminal', message),
    );
    newSocket.connect();
    newSession.socket = newSocket;
    multiSocketsRef.current[sessionId] = newSocket;
    setMultiSessions((prev) => addSession(prev, newSession));
  }, [connection]);`
);

code = code.replace(
  'const handleCloseSession = useCallback(async (sessionId: string) => {\n    const session = multiSessions[sessionId];\n    if (!session || !connection) return;\n    session.socket?.close();\n    try {\n      await new AgenticRemoteAPI(connection).closeSession(sessionId);\n      setMultiSessions((prev) => closeSession(prev, sessionId));\n    } catch (error) {\n      if (!(error instanceof APIError && error.status === 404)) {\n        Alert.alert(\'Could not close session\', error instanceof Error ? error.message : \'Unknown error\');\n      }\n    }\n  }, [multiSessions, connection]);',
  `const handleCloseSession = useCallback(async (sessionId: string) => {
    const s = multiSocketsRef.current[sessionId];
    if (!s || !connection) return;
    s.close();
    delete multiSocketsRef.current[sessionId];
    setMultiSessions((prev) => closeSession(prev, sessionId));
    try {
      await new AgenticRemoteAPI(connection).closeSession(sessionId);
    } catch (error) {
      if (!(error instanceof APIError && error.status === 404)) {
        Alert.alert('Could not close session', error instanceof Error ? error.message : 'Unknown error');
      }
    }
  }, [connection]);`
);

code = code.replace(
  'const handleInput = useCallback((sessionId: string, data: string) => {\n    multiSessions[sessionId]?.socket?.input(data);\n  }, [multiSessions]);',
  `const handleInput = useCallback((sessionId: string, data: string) => {
    if (isBroadcasting) {
      Object.values(multiSocketsRef.current).forEach((s) => s.input(data));
    } else {
      multiSocketsRef.current[sessionId]?.input(data);
    }
  }, [isBroadcasting]);`
);

code = code.replace(
  'const handleResize = useCallback((sessionId: string, cols: number, rows: number) => {\n    multiSessions[sessionId]?.socket?.resize(cols, rows);\n  }, [multiSessions]);',
  `const handleResize = useCallback((sessionId: string, cols: number, rows: number) => {
    multiSocketsRef.current[sessionId]?.resize(cols, rows);
  }, []);`
);

code = code.replace(
  'const isMultiMode = mode === \'multi\';',
  `const handleCloseAll = useCallback(async () => {
    socket.current?.close();
    if (connection) {
      const restApi = new AgenticRemoteAPI(connection);
      for (const sessionId of Object.keys(multiSocketsRef.current)) {
        const s = multiSocketsRef.current[sessionId];
        if (s) s.close();
        try {
          await restApi.closeSession(sessionId);
        } catch (error) {
          if (!(error instanceof APIError && error.status === 404)) console.warn(error);
        }
      }
    }
    Object.values(multiSocketsRef.current).forEach((s) => s.close());
    multiSocketsRef.current = {};
    setMultiSessions({});
    router.replace('/');
  }, [connection]);

  const isMultiModeCheck = mode === 'multi';`
);

code = code.replace(
  'if (isMultiMode && connection && id && Object.keys(multiSessions).length === 0) {',
  'if (isMultiModeCheck && connection && id && Object.keys(multiSessions).length === 0) {'
);

code = code.replace(
  '}, [isMultiMode, connection, id, name, multiSessions, handleAddSession]);',
  '}, [isMultiModeCheck, connection, id, name, multiSessions, handleAddSession]);'
);

code = code.replace(
  'if (isMultiMode) {',
  'if (isMultiModeCheck) {'
);

code = code.replace(
  'onPress={() => router.replace(\'/\')}',
  'onPress={handleCloseAll}'
);

code = code.replace(
  'multiSessions[sessionId]?.socket?.input(data)',
  'multiSocketsRef.current[sessionId]?.input(data)'
);

fs.writeFileSync('client/app/terminal/[id].tsx', code);
