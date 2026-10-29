// The only background work: open the setup page once, right after installation. Everything else
// happens in the new tab and settings pages, so nothing has to keep running.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('options.html?welcome=1') });
});
