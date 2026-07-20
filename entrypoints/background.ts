export default defineBackground(() => {
  // Thin glue only: the orchestrator lives in the side panel.
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err: unknown) => console.error('sidePanel setup failed', err));
});
