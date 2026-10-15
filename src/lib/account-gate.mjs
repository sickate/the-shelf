// Initialization and authentication writes share one gate. allSettled prevents a
// failed startup request from leaving another session response racing a retry.
export function accountGate({
  fieldset,
  retryButton,
  loadConfig,
  loadSession,
  onReady,
  onFailure,
  onPending = () => {},
}) {
  let ready = false,
    busy = false;
  fieldset.disabled = true;
  retryButton.hidden = true;
  retryButton.disabled = true;
  return {
    get ready() {
      return ready && !busy;
    },
    async initialize() {
      if (busy) return;
      ready = false;
      busy = true;
      fieldset.disabled = true;
      retryButton.hidden = true;
      retryButton.disabled = true;
      try {
        onPending();
        const outcomes = await Promise.allSettled([
          Promise.resolve().then(loadConfig),
          Promise.resolve().then(loadSession),
        ]);
        const failure = outcomes.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
        const config = outcomes[0].value,
          session = outcomes[1].value;
        if (
          config?.apiConfigured !== true ||
          typeof session?.authenticated !== "boolean" ||
          (session.authenticated &&
            (typeof session.csrfToken !== "string" || !session.csrfToken)) ||
          (!session.authenticated && session.csrfToken !== null)
        )
          throw new Error("登录状态暂时无法确认，请重新检查连接。");
        await onReady(config, session);
        ready = true;
      } catch (error) {
        onFailure(error);
      } finally {
        busy = false;
        fieldset.disabled = !ready;
        retryButton.hidden = ready;
        retryButton.disabled = false;
      }
    },
    async run(operation) {
      if (!ready || busy) return;
      busy = true;
      fieldset.disabled = true;
      retryButton.disabled = true;
      try {
        return await operation();
      } finally {
        busy = false;
        fieldset.disabled = !ready;
        retryButton.disabled = false;
      }
    },
  };
}
