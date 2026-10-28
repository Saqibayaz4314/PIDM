import { api } from './connection.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'personal-download-link', title: 'Download with PIDM', contexts: ['link'] });
  chrome.contextMenus.create({ id: 'personal-download-page', title: 'Download page URL with PIDM', contexts: ['page'] });
});

async function sendUrl(url, mode = 'auto', browserMedia = {}) {
  if (!/^https?:\/\//i.test(url || '')) return { ok: false, error: 'Only direct HTTP and HTTPS URLs are supported.' };
  try {
    if (mode === 'video') {
      const key = `video-${crypto.randomUUID()}`;
      await chrome.storage.session.set({ [key]: { url, mode, mediaUrl: browserMedia.mediaUrl, userAgent: browserMedia.userAgent } });
      await chrome.tabs.create({ url: `${chrome.runtime.getURL('choose.html')}?request=${encodeURIComponent(key)}` });
      return { ok: true, selecting: true };
    }
    await api('jobs', { url, mode, segments: 4, mediaUrl: browserMedia.mediaUrl, userAgent: browserMedia.userAgent });
    await chrome.action.setBadgeBackgroundColor({ color: '#258451' });
    await chrome.action.setBadgeText({ text: '✓' });
    return { ok: true };
  } catch (error) {
    console.warn('PIDM:', error);
    await chrome.action.setBadgeBackgroundColor({ color: '#b84242' });
    await chrome.action.setBadgeText({ text: '!' });
    return { ok: false, error: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'download-url') return;
  void sendUrl(message.url, message.mode, message).then(sendResponse);
  return true;
});

chrome.contextMenus.onClicked.addListener(info => {
  void sendUrl(info.linkUrl || info.pageUrl, info.linkUrl ? 'auto' : 'video');
});

chrome.action.onClicked.addListener(tab => {
  if (tab.url) void sendUrl(tab.url, 'video');
  else void chrome.runtime.openOptionsPage();
});
