const menuId = "open-pdf-reader";
const readerUrl = chrome.runtime.getURL("reader.html");
const supportedProtocols = ["file:", "http:", "https:"];

function parseSource(value) {
  try {
    const url = new URL(value);
    return supportedProtocols.includes(url.protocol) && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

function openReader(url) {
  const hash = url ? `#${new URLSearchParams({ file: url.href })}` : "";
  chrome.tabs.create({ url: readerUrl + hash });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: menuId,
    title: "用 PDF 护眼阅读器打开",
    contexts: ["link", "page"],
    documentUrlPatterns: ["*://*/*", "file:///*"],
    targetUrlPatterns: ["*://*/*", "file:///*"],
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.url?.split("#")[0] === readerUrl) return;

  const url = parseSource(tab.url);
  const isPdf = url && /(?:\.|%2e)pdf$/i.test(url.pathname);
  openReader(isPdf ? url : null);
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== menuId) return;

  const url = parseSource(info.linkUrl || info.frameUrl || info.pageUrl);
  if (url) openReader(url);
});
