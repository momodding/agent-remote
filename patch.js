const fs = require('fs');
const content = fs.readFileSync('client/app/terminal/[id].tsx', 'utf8');
const replacement = `
  const handleCloseAll = useCallback(async () => {
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

  const isMultiModeCheck = mode === 'multi';`;
const newContent = content.replace("const isMultiMode = mode === 'multi';", replacement).replace("isMultiMode)", "isMultiModeCheck)").replace("!isMultiMode", "!isMultiModeCheck").replace(/\[connect, connectionEndpoint, isMultiMode\]/g, "[connect, connectionEndpoint, isMultiModeCheck]").replace(/\[connection, connect, isMultiMode\]/g, "[connection, connect, isMultiModeCheck]").replace("onPress={() => router.replace('/')}", "onPress={handleCloseAll}");
fs.writeFileSync('client/app/terminal/[id].tsx', newContent);
