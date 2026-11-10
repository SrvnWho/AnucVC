import { io } from 'socket.io-client';
import { VoiceManager, SFU_ROOM_ID, SCREEN_QUALITY_PRESETS, loadIceServers } from './webrtc.js';

function showAppAlert(message, title = 'Bilgilendirme') {
  try {
    const alertModal = document.getElementById('app-alert-modal');
    const alertTitle = document.getElementById('app-alert-title');
    const alertMsg = document.getElementById('app-alert-message');
    const btnClose = document.getElementById('btn-close-app-alert');

    if (alertTitle) alertTitle.textContent = title;
    if (alertMsg) alertMsg.textContent = message;

    if (btnClose) {
      btnClose.onclick = () => {
        if (alertModal) alertModal.classList.add('hidden');
      };
    }

    if (alertModal) alertModal.classList.remove('hidden');
  } catch (e) {
    console.log(message);
  }
}

// Lightweight, self-dismissing corner notification (distinct from
// showAppAlert, which is a blocking modal). Creates its container lazily
// so it works from anywhere without needing markup in index.html.
function showToast(message, type = 'info') {
  try {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = String(message || '');
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('toast-visible'));

    setTimeout(() => {
      toast.classList.remove('toast-visible');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
      setTimeout(() => toast.remove(), 500);
    }, 3500);
  } catch (e) {
    console.log(message);
  }
}

// Desktop auto-update UI for the check_update / install_update commands in
// src-tauri/src/main.rs, which replace Tauri's built-in updater dialog. The
// progress bar is the point: installers come from our own server, whose
// uplink can make one download take a minute, and with no feedback at all
// that looked like the update had hung.
const UPDATE_RECHECK_MS = 4 * 60 * 60 * 1000;
let updateToastEl = null;
let updateInstallStarted = false;

function getUpdateToast() {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  if (!updateToastEl) {
    updateToastEl = document.createElement('div');
    updateToastEl.className = 'toast toast-update';
    container.appendChild(updateToastEl);
    requestAnimationFrame(() => updateToastEl?.classList.add('toast-visible'));
  }
  return updateToastEl;
}

function closeUpdateToast() {
  updateToastEl?.remove();
  updateToastEl = null;
}

function makeUpdateToastPart(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className;
  if (text) el.textContent = text;
  return el;
}

function showUpdateAvailable(version, invoke) {
  const toast = getUpdateToast();
  toast.dataset.mode = 'available';
  const actions = makeUpdateToastPart('div', 'toast-update-actions');
  const later = makeUpdateToastPart('button', 'toast-update-btn secondary', 'Sonra');
  const now = makeUpdateToastPart('button', 'toast-update-btn', 'Şimdi güncelle');
  later.type = 'button';
  now.type = 'button';
  later.addEventListener('click', closeUpdateToast);
  now.addEventListener('click', () => {
    updateInstallStarted = true;
    showUpdateProgress(0, 0);
    // A successful install never resolves: the process exits for the installer
    // (Windows) or restarts (macOS). Resolving means there was nothing to do.
    invoke('install_update').then(() => {
      updateInstallStarted = false;
      closeUpdateToast();
    }, (err) => {
      updateInstallStarted = false;
      showUpdateError(String(err));
    });
  });
  actions.append(later, now);
  toast.replaceChildren(
    makeUpdateToastPart('div', 'toast-update-title', `AnucVC ${version} hazır`),
    makeUpdateToastPart('div', 'toast-update-text', 'İndirilip kurulur, ardından uygulama kendini yeniden açar.'),
    actions
  );
}

function showUpdateProgress(received, total) {
  const toast = getUpdateToast();
  if (toast.dataset.mode !== 'progress') {
    toast.dataset.mode = 'progress';
    const bar = makeUpdateToastPart('div', 'toast-update-progress');
    bar.appendChild(document.createElement('span'));
    toast.replaceChildren(
      makeUpdateToastPart('div', 'toast-update-title', 'Güncelleme indiriliyor…'),
      bar,
      makeUpdateToastPart('div', 'toast-update-text', 'Başlatılıyor…')
    );
  }
  const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
  toast.querySelector('.toast-update-progress > span').style.width = `${pct}%`;
  const mb = (n) => (n / 1048576).toFixed(1);
  if (total > 0) {
    toast.querySelector('.toast-update-text').textContent = `%${pct} · ${mb(received)} / ${mb(total)} MB`;
  } else if (received > 0) {
    toast.querySelector('.toast-update-text').textContent = `${mb(received)} MB indirildi`;
  }
}

function showUpdateMessage(mode, title, text, closable) {
  const toast = getUpdateToast();
  toast.dataset.mode = mode;
  const parts = [makeUpdateToastPart('div', 'toast-update-title', title), makeUpdateToastPart('div', 'toast-update-text', text)];
  if (closable) {
    const actions = makeUpdateToastPart('div', 'toast-update-actions');
    const close = makeUpdateToastPart('button', 'toast-update-btn secondary', 'Kapat');
    close.type = 'button';
    close.addEventListener('click', closeUpdateToast);
    actions.appendChild(close);
    parts.push(actions);
  }
  toast.replaceChildren(...parts);
}

function showUpdateError(message) {
  showUpdateMessage('error', 'Güncelleme tamamlanamadı', message || 'Bilinmeyen hata', true);
}

function initDesktopUpdates() {
  if (!isRunningInTauri) return;
  (async () => {
    let invoke;
    try {
      ({ invoke } = await import('@tauri-apps/api/tauri'));
      const { listen } = await import('@tauri-apps/api/event');
      let received = 0;
      await listen('tauri://update-download-progress', ({ payload }) => {
        if (!updateInstallStarted) return;
        received += payload?.chunkLength || 0;
        showUpdateProgress(received, payload?.contentLength || 0);
      });
      await listen('tauri://update-status', ({ payload }) => {
        // Background checks report their failures here too (offline, server
        // restarting) - only an update the user actually started may say so.
        if (!updateInstallStarted) return;
        if (payload?.status === 'DOWNLOADED') {
          showUpdateMessage('installing', 'Kurulum başlıyor…', 'AnucVC birazdan kapanıp yeni sürümle açılacak.', false);
        } else if (payload?.status === 'ERROR') {
          updateInstallStarted = false;
          received = 0;
          showUpdateError(payload.error);
        }
      });
    } catch (err) {
      console.warn('Desktop update UI unavailable:', err);
      return;
    }
    const check = async () => {
      // The app lives in the tray for days, so one check at launch isn't enough.
      if (updateInstallStarted || updateToastEl) return;
      try {
        const version = await invoke('check_update');
        if (version) showUpdateAvailable(version, invoke);
      } catch (err) {
        console.warn('Update check failed:', err);
      }
    };
    check();
    setInterval(check, UPDATE_RECHECK_MS);
  })();
}

// Surface any otherwise-silent JS error as a visible banner instead of
// leaving the app looking like it just "loaded empty" with no explanation.
// This is deliberately self-contained (no dependency on other app state)
// so it works even if something fails very early during startup.
function reportFatalClientError(message) {
  console.error('[AnucVC fatal]', message);
  try {
    let banner = document.getElementById('fatal-error-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'fatal-error-banner';
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#f23f43;color:#fff;' +
        'font:600 13px system-ui,sans-serif;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:8px;' +
        'box-shadow:0 2px 8px rgba(0,0,0,0.3);';
      document.body.appendChild(banner);
    }
    const safeMsg = escapeHtml(String(message || ''));
    banner.innerHTML = `<span>Bir hata oluştu: ${safeMsg}</span><button onclick="this.parentElement.remove()" style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1;">&times;</button>`;
    banner.style.display = 'flex';
  } catch (e) {
    // If even this fails, there's nothing more we can safely do client-side.
  }
}

window.addEventListener('error', (event) => {
  reportFatalClientError(event.message || 'Bilinmeyen hata');
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const message = (reason && (reason.message || reason.toString())) || 'Bilinmeyen hata (promise reddedildi)';
  reportFatalClientError(message);
});

let socket = null;
let voiceManager = null;
let currentTextRoom = 'genel';
let currentVoiceRoom = null;
let voiceOccupantsMap = {};
// Baseline for the join/leave sound diff below - which room it was captured
// for, so a room switch doesn't get misread as everyone in the new room
// having "just joined".
let lastKnownVoiceOccupantIds = new Set();
let lastKnownVoiceOccupantRoom = null;
let lastFetchedRooms = null;
let lastNonZeroVolumeMap = {};
let selectedImageData = null;
let pendingAvatarDataUrl = null;

// New feature states
let unreadCounts = {};
let typingTimeout = null;
let typingUsers = {};
let membersVisible = true;
let isLoadingOlderMessages = false;

// Message Caching System (RAM + LocalStorage)
const MESSAGE_CACHE_KEY = 'anucvc_messages_cache_v1';
let messageCache = {};

// DM read receipts (Telegram-style ticks): roomId -> {userId: lastReadMessageId}.
// Not persisted to localStorage - always re-fetched fresh via message-history
// when a DM is opened, since it's cheap and staleness here would show wrong
// ticks.
let dmReadState = {};

function loadMessageCacheFromStorage() {
  try {
    const raw = localStorage.getItem(MESSAGE_CACHE_KEY);
    if (raw) {
      messageCache = JSON.parse(raw) || {};
    }
  } catch (err) {
    console.warn('Failed to load message cache from localStorage:', err);
    messageCache = {};
  }
}

function writeMessageCacheToStorage() {
  try {
    const storageCache = {};
    for (const roomId in messageCache) {
      if (Array.isArray(messageCache[roomId])) {
        // Store up to 40 most recent messages per room in localStorage
        const recent = messageCache[roomId].slice(-40).map(msg => {
          if (msg.image_data && msg.image_data.length > 100000) {
            return { ...msg, image_data: null };
          }
          return msg;
        });
        storageCache[roomId] = recent;
      }
    }
    localStorage.setItem(MESSAGE_CACHE_KEY, JSON.stringify(storageCache));
  } catch (err) {
    console.warn('Failed to save message cache to localStorage:', err);
  }
}

// Serializing the whole cache (which can hold base64 images) is a synchronous,
// main-thread, blocking operation. It used to run on *every* incoming message -
// exactly when the UI is busy appending and scrolling. Coalescing the writes
// into one idle pass removes that jank without risking data loss: a flush is
// forced when the page is hidden or unloaded.
let messageCacheFlushTimer = null;
const scheduleIdle = window.requestIdleCallback
  ? (fn, timeout) => window.requestIdleCallback(fn, { timeout })
  : (fn, timeout) => setTimeout(fn, Math.min(timeout, 400));

function saveMessageCacheToStorage() {
  if (messageCacheFlushTimer !== null) return;
  messageCacheFlushTimer = scheduleIdle(() => {
    messageCacheFlushTimer = null;
    writeMessageCacheToStorage();
  }, 1500);
}

function flushMessageCacheNow() {
  if (messageCacheFlushTimer !== null) {
    if (window.cancelIdleCallback) window.cancelIdleCallback(messageCacheFlushTimer);
    else clearTimeout(messageCacheFlushTimer);
    messageCacheFlushTimer = null;
  }
  writeMessageCacheToStorage();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushMessageCacheNow();
});
window.addEventListener('pagehide', flushMessageCacheNow);

loadMessageCacheFromStorage();

// Mention system state
let allUsersCache = []; // [{id, username, avatar}] - all registered users
let onlineUsernamesSet = new Set(); // usernames currently online (lowercase)
let mentionActive = false;
let mentionQueryStart = -1; // index in chatInput.value where "@" starts
let mentionSelectedIndex = 0;
let mentionCurrentResults = [];

// Auth State
let authToken = localStorage.getItem('anucvc_token') || null;
let currentUser = null;
try {
  currentUser = JSON.parse(localStorage.getItem('anucvc_user') || 'null');
} catch (e) {
  currentUser = null;
}

let username = currentUser ? currentUser.username : (localStorage.getItem('anucvc_username') || `User_${Math.floor(1000 + Math.random() * 9000)}`);
let userAvatar = currentUser ? currentUser.avatar : null;

const AI_BOT_USERNAME = 'AnucAI';
const isAiBot = (uname) => (uname || '').toLowerCase() === AI_BOT_USERNAME.toLowerCase();

// Fixed reaction set - matches ALLOWED_REACTIONS in server/server.js.
const ALLOWED_REACTIONS = ['😀', '🥹', '😍', '🤪', '😱', '👍', '👎', '🖕', '🍆'];

// --- Appearance settings (accent color / compact mode / font size) -------
// Applied immediately at load, not just when Settings is opened, so a saved
// preference is visible from first paint instead of flashing the defaults.
function shadeHexColor(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const r = Math.max(0, Math.min(255, (num >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0x00ff) + amt));
  const b = Math.max(0, Math.min(255, (num & 0x0000ff) + amt));
  return `#${(0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1)}`;
}

// --accent-color alone isn't enough - avatars, primary buttons etc. use
// --accent-gradient (a two-color gradient), so a solid custom color without
// a matching gradient would leave those looking like the old default.
function applyAccentColor(color, gradientTo) {
  const toColor = gradientTo || shadeHexColor(color, -20);
  document.documentElement.style.setProperty('--accent-color', color);
  document.documentElement.style.setProperty('--accent-gradient', `linear-gradient(135deg, ${color} 0%, ${toColor} 100%)`);
  localStorage.setItem('anucvc_accent_color', color);
  localStorage.setItem('anucvc_accent_gradient_to', toColor);
}

function applyFontSizeClass(size) {
  document.body.classList.toggle('font-size-small', size === 'small');
  document.body.classList.toggle('font-size-large', size === 'large');
}

(function applyAppearanceSettings() {
  const savedColor = localStorage.getItem('anucvc_accent_color');
  if (savedColor) {
    const savedGradientTo = localStorage.getItem('anucvc_accent_gradient_to') || shadeHexColor(savedColor, -20);
    document.documentElement.style.setProperty('--accent-color', savedColor);
    document.documentElement.style.setProperty('--accent-gradient', `linear-gradient(135deg, ${savedColor} 0%, ${savedGradientTo} 100%)`);
  }
  document.body.classList.toggle('compact-mode', localStorage.getItem('anucvc_compact_mode') === 'true');
  applyFontSizeClass(localStorage.getItem('anucvc_font_size') || 'medium');
})();

// Fixed server URL for single server architecture & Tauri desktop app
const origin = window.location.origin || '';
const isRunningInTauri = !!(window.__TAURI__ || window.__TAURI_IPC__ || window.__TAURI_INTERNALS__);
let serverUrl = origin;
if (
  isRunningInTauri ||
  !origin ||
  origin === 'null' ||
  origin.startsWith('tauri://') ||
  origin.startsWith('file://') ||
  origin.includes('tauri.localhost')
) {
  // Note: on Windows, Tauri v1's WebView2 serves the bundled app from
  // https://tauri.localhost (not tauri:// or file://), so relying on the
  // origin string alone silently missed this platform and made the app
  // treat its own local page as the API/socket server, wrongly returning
  // empty rooms/users. Checking for the Tauri globals directly is reliable
  // on every platform.
  serverUrl = 'https://anuc.servanerbey.com';
}

initDesktopUpdates();

// Modal & Context menu states
let authMode = 'login';
let channelModalMode = 'create';
let channelModalType = 'text';
let targetChannelForAction = null;
let confirmActionType = 'delete-channel';
let targetUserSocketIdForVol = null;
// The context menu is shared between a person (microphone level) and a stream
// tile (that share's own audio level) - this says which one it is showing.
let ctxVolumeMode = 'mic';
let targetStreamOwnerId = null;
let targetMessageForEdit = null;
let targetMessageForDelete = null;

// Avatar Cropper State
let cropImageObj = null;
let cropZoom = 1;
let cropOffsetX = 0;
let cropOffsetY = 0;
let isDraggingCrop = false;
let dragStartX = 0;
let dragStartY = 0;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Auth Elements
const authOverlay = document.getElementById('auth-overlay');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const groupUsername = document.getElementById('group-username');
const authUsernameInput = document.getElementById('auth-username');
const authEmailInput = document.getElementById('auth-email');
const authPasswordInput = document.getElementById('auth-password');
const authErrorBadge = document.getElementById('auth-error');
const btnAuthSubmit = document.getElementById('btn-auth-submit');

// DOM Elements
const textChannelsContainer = document.getElementById('text-channels');
const voiceChannelsContainer = document.getElementById('voice-channels');
const currentChannelNameElem = document.getElementById('current-channel-name');
const messagesContainer = document.getElementById('messages-container');

// Whether the reader is parked at the newest message. Only real scroll events
// change it: content growing underneath (a new message, an image decoding,
// the typing bar appearing) must not count as "scrolled away", or the list
// would stop following the conversation.
const PINNED_TO_BOTTOM_PX = 80;
let isPinnedToBottom = true;
// The channel-switch glide is briefly not at the bottom on purpose - it still
// counts as pinned while it runs, and always ends with a snap to the bottom.
const REVEAL_GLIDE_MS = 600;
let revealInProgress = false;
let revealSnapTimer = null;
let unseenMessagesCount = 0;
let newMessagesPill = null;
// Rooms whose first message is already on screen - no point asking the server
// for more every time the reader nudges the top.
const reachedOldestMessage = new Set();
const chatInput = document.getElementById('chat-input');
const btnSendMessage = document.getElementById('btn-send-message');
const displayNameElem = document.getElementById('display-name');
const userAvatarInitial = document.getElementById('user-avatar-initial');
const userTag = document.getElementById('user-tag');

// Online Users Panel
const onlineUsersPanel = document.getElementById('online-users-panel');
const onlineUsersList = document.getElementById('online-users-list');
const onlineCountBadge = document.getElementById('online-count');
const offlineUsersList = document.getElementById('offline-users-list');
const offlineCountBadge = document.getElementById('offline-count');
const btnToggleMembers = document.getElementById('btn-toggle-members');

// GIF Picker Elements
const btnToggleGif = document.getElementById('btn-toggle-gif');
const gifPickerPopover = document.getElementById('gif-picker-popover');
const gifSearchInput = document.getElementById('gif-search-input');
const gifPickerResults = document.getElementById('gif-picker-results');
const btnCloseGifPicker = document.getElementById('btn-close-gif-picker');

// Typing Indicator
const typingIndicator = document.getElementById('typing-indicator');
const typingText = document.getElementById('typing-text');

// Notification Sound
const notificationSound = document.getElementById('notification-sound');
const userAvatarImg = document.getElementById('user-avatar-img');
const btnToggleMic = document.getElementById('btn-toggle-mic');
const btnToggleDeaf = document.getElementById('btn-toggle-deaf');

// Image Attachment & Lightbox Elements
const imageFileInput = document.getElementById('image-file-input');
const btnAttachImage = document.getElementById('btn-attach-image');
const imagePreviewBar = document.getElementById('image-preview-bar');
const imagePreviewThumb = document.getElementById('image-preview-thumb');
const btnRemoveImage = document.getElementById('btn-remove-image');
const imageLightboxModal = document.getElementById('image-lightbox-modal');
const lightboxFullImg = document.getElementById('lightbox-full-img');
const btnCloseLightbox = document.getElementById('btn-close-lightbox');

// Settings & Avatar Cropper Elements
const btnSettings = document.getElementById('btn-settings');
const settingsModal = document.getElementById('settings-modal');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnLogoutSettings = document.getElementById('btn-logout-settings');
const inputUsername = document.getElementById('input-username');
const inputBio = document.getElementById('input-bio');
const bioCharCounter = document.getElementById('bio-char-counter');
const inputStatus = document.getElementById('input-status');
const statusCharCounter = document.getElementById('status-char-counter');
const settingsAvatarPreview = document.getElementById('settings-avatar-preview');
const settingsAvatarInitial = document.getElementById('settings-avatar-initial');
const settingsAvatarImg = document.getElementById('settings-avatar-img');
const inputAvatarFile = document.getElementById('input-avatar-file');

// Mic Test Elements
const btnTestMic = document.getElementById('btn-test-mic');
const txtTestMic = document.getElementById('txt-test-mic');
const micTestVisualizer = document.getElementById('mic-test-visualizer');
const iconPlay = btnTestMic ? btnTestMic.querySelector('.icon-play') : null;
const iconStop = btnTestMic ? btnTestMic.querySelector('.icon-stop') : null;

function stopMicTestUI() {
  if (voiceManager) {
    voiceManager.stopMicTest();
  }
  if (btnTestMic) {
    btnTestMic.classList.remove('testing');
  }
  if (txtTestMic) {
    txtTestMic.textContent = 'Kendi Sesini Test Et';
  }
  if (iconPlay) iconPlay.classList.remove('hidden');
  if (iconStop) iconStop.classList.add('hidden');
  if (micTestVisualizer) micTestVisualizer.classList.add('hidden');
}

// Change Password Elements
const btnOpenChangePassword = document.getElementById('btn-open-change-password');
const changePasswordModal = document.getElementById('change-password-modal');
const btnCloseChangePw = document.getElementById('btn-close-change-pw');
const btnCancelChangePw = document.getElementById('btn-cancel-change-pw');
const btnSaveChangePw = document.getElementById('btn-save-change-pw');
const inputOldPw = document.getElementById('input-old-pw');
const inputNewPw = document.getElementById('input-new-pw');
const inputConfirmNewPw = document.getElementById('input-confirm-new-pw');
const changePwError = document.getElementById('change-pw-error');

const avatarCropModal = document.getElementById('avatar-crop-modal');
const cropCanvas = document.getElementById('crop-canvas');
const cropZoomRange = document.getElementById('crop-zoom-range');
const btnCancelCrop = document.getElementById('btn-cancel-crop');
const btnApplyCrop = document.getElementById('btn-apply-crop');

let pendingBannerDataUrl = null;
let bannerCropImageObj = null;
let bannerCropZoom = 1;
let bannerCropOffsetX = 0;
let bannerCropOffsetY = 0;
let isDraggingBannerCrop = false;
let bannerDragStartX = 0;
let bannerDragStartY = 0;

const settingsBannerPreview = document.getElementById('settings-banner-preview');
const settingsBannerImg = document.getElementById('settings-banner-img');
const inputBannerFile = document.getElementById('input-banner-file');
const bannerCropModal = document.getElementById('banner-crop-modal');
const bannerCropCanvas = document.getElementById('banner-crop-canvas');
const bannerCropZoomRange = document.getElementById('banner-crop-zoom-range');
const btnCancelBannerCrop = document.getElementById('btn-cancel-banner-crop');
const btnApplyBannerCrop = document.getElementById('btn-apply-banner-crop');

// Channel modal
const btnAddTextChannel = document.getElementById('btn-add-text-channel');
const btnAddVoiceChannel = document.getElementById('btn-add-voice-channel');
const btnRenameChannel = document.getElementById('btn-rename-channel');
const channelModal = document.getElementById('channel-modal');
const channelModalTitle = document.getElementById('channel-modal-title');
const inputChannelName = document.getElementById('input-channel-name');
const btnSaveChannelModal = document.getElementById('btn-save-channel-modal');
const btnCancelChannelModal = document.getElementById('btn-cancel-channel-modal');

// Edit Message Modal
const editMessageModal = document.getElementById('edit-message-modal');
const inputEditMsg = document.getElementById('input-edit-msg');
const btnSaveEditMsg = document.getElementById('btn-save-edit-msg');
const btnCancelEditMsg = document.getElementById('btn-cancel-edit-msg');

// Custom Confirm Modal
const confirmModal = document.getElementById('confirm-modal');
const confirmModalTitle = document.getElementById('confirm-modal-title');
const confirmModalText = document.getElementById('confirm-modal-text');
const btnCancelConfirm = document.getElementById('btn-cancel-confirm');
const btnAcceptConfirm = document.getElementById('btn-accept-confirm');

// Account Deleted Modal elements
const accountDeletedModal = document.getElementById('account-deleted-modal');
const accountDeletedMessage = document.getElementById('account-deleted-message');
const btnAccountDeletedOk = document.getElementById('btn-account-deleted-ok');

// Context Menus
const contextMenu = document.getElementById('context-menu');
const ctxMuteChannel = document.getElementById('ctx-mute-channel');
const ctxMuteText = document.getElementById('ctx-mute-text');
const ctxRename = document.getElementById('ctx-rename');
const ctxDelete = document.getElementById('ctx-delete');

const MUTED_CHANNELS_KEY = 'anucvc_muted_channels';
let mutedChannels = {};
try {
  mutedChannels = JSON.parse(localStorage.getItem(MUTED_CHANNELS_KEY) || '{}');
} catch (e) {
  mutedChannels = {};
}

function saveMutedChannelsToStorage() {
  try {
    localStorage.setItem(MUTED_CHANNELS_KEY, JSON.stringify(mutedChannels));
  } catch (e) {}
}

const userContextMenu = document.getElementById('user-context-menu');
const userCtxName = document.getElementById('user-ctx-name');
const userCtxVolSlider = document.getElementById('user-ctx-vol-slider');
const userCtxVolTxt = document.getElementById('user-ctx-vol-txt');
const userCtxSpeakerBtn = document.getElementById('user-ctx-speaker-btn');
const userCtxMuteNotif = document.getElementById('user-ctx-mute-notifications');
const userCtxMuteNotifText = document.getElementById('user-ctx-mute-notif-text');
const userCtxSetNickname = document.getElementById('user-ctx-set-nickname');
const userCtxVolLabel = document.getElementById('user-ctx-vol-label');
const userCtxStreamToggle = document.getElementById('user-ctx-stream-toggle');
const userCtxStreamToggleText = document.getElementById('user-ctx-stream-toggle-text');

// Mini Profile Popover Elements
const userProfilePopover = document.getElementById('user-profile-popover');
const popoverAvatarBox = document.getElementById('popover-avatar-box');
const popoverAvatarInitial = document.getElementById('popover-avatar-initial');
const popoverAvatarImg = document.getElementById('popover-avatar-img');
const popoverUsername = document.getElementById('popover-username');
const popoverUsertag = document.getElementById('popover-usertag');
const popoverNicknameRow = document.getElementById('popover-nickname-row');
const popoverNicknameVal = document.getElementById('popover-nickname-val');
const popoverBio = document.getElementById('popover-bio');

// Nickname Modal Elements
const nicknameModal = document.getElementById('nickname-modal');
const inputNickname = document.getElementById('input-nickname');
const btnCancelNickname = document.getElementById('btn-cancel-nickname');
const btnSaveNickname = document.getElementById('btn-save-nickname');

// Local User Preferences (Nicknames & Muted Users)
const USER_NICKNAMES_KEY = 'anucvc_user_nicknames_v1';
const MUTED_USERS_KEY = 'anucvc_muted_users_v1';
let userNicknames = {};
let mutedUsers = {};
let targetUserForAction = null;
let lastOnlineData = null;

try {
  userNicknames = JSON.parse(localStorage.getItem(USER_NICKNAMES_KEY) || '{}');
  mutedUsers = JSON.parse(localStorage.getItem(MUTED_USERS_KEY) || '{}');
} catch (e) {
  userNicknames = {};
  mutedUsers = {};
}

function saveUserPrefsToStorage() {
  try {
    localStorage.setItem(USER_NICKNAMES_KEY, JSON.stringify(userNicknames));
    localStorage.setItem(MUTED_USERS_KEY, JSON.stringify(mutedUsers));
  } catch (e) {}
}

// Voice bar & Call View
const voiceStatusBar = document.getElementById('voice-status-bar');
const voiceRoomNameElem = document.getElementById('voice-room-name');
const btnDisconnectVoice = document.getElementById('btn-disconnect-voice');
const btnExpandCallView = document.getElementById('btn-expand-call-view');
const connectionStatusBanner = document.getElementById('connection-status-banner');
const connectionStatusText = document.getElementById('connection-status-text');

const callView = document.getElementById('call-view');
const callViewGrid = document.getElementById('call-view-grid');
const callViewRoomTitle = document.getElementById('call-view-room-title');
const callViewCount = document.getElementById('call-view-count');
const btnMinimizeCallView = document.getElementById('btn-minimize-call-view');
const callViewUnreadBadge = document.getElementById('call-view-unread-badge');
const btnCallMic = document.getElementById('call-btn-mic');
const btnCallDeafen = document.getElementById('call-btn-deafen');
const btnCallCamera = document.getElementById('call-btn-camera');
const btnCallScreenshare = document.getElementById('call-btn-screenshare');
const btnCallLeave = document.getElementById('call-btn-leave');

let callViewOpen = false;
let unreadWhileInCallView = 0;

let keyboardShortcuts = {};
try {
  keyboardShortcuts = JSON.parse(localStorage.getItem('anucvc_shortcuts') || '{}');
} catch (e) {
  keyboardShortcuts = {};
}
let isRecordingShortcut = false;

const UNREAD_COUNTS_KEY = 'anucvc_unread_counts';
const UNREAD_MENTIONS_KEY = 'anucvc_unread_mentions';

function loadUnreadStateFromStorage() {
  try {
    const savedCounts = localStorage.getItem(UNREAD_COUNTS_KEY);
    if (savedCounts) {
      unreadCounts = JSON.parse(savedCounts);
    }
    const savedMentions = localStorage.getItem(UNREAD_MENTIONS_KEY);
    if (savedMentions) {
      totalUnreadMentions = parseInt(savedMentions, 10) || 0;
    }
  } catch (e) {
    console.error('Error loading unread state:', e);
  }
}

function saveUnreadStateToStorage() {
  try {
    localStorage.setItem(UNREAD_COUNTS_KEY, JSON.stringify(unreadCounts));
    localStorage.setItem(UNREAD_MENTIONS_KEY, String(totalUnreadMentions));
  } catch (e) {}
}

async function initApp() {
  setupAuthEventListeners();
  loadUnreadStateFromStorage();
  updateFriendsTabBadge();

  try {
    if (authToken) {
      const isValid = await verifySession();
      if (isValid) {
        authOverlay.classList.add('hidden');
        updateUserDisplay();
        fetchRooms().then(() => {
          joinTextRoom(currentTextRoom);
        });
        fetchAllUsers();
        connectSocket();
        updateAppBadgeCount(totalUnreadMentions);
      } else {
        showAuthScreen();
      }
    } else {
      showAuthScreen();
    }
  } catch (err) {
    console.error('Error during app startup:', err);
    reportFatalClientError(err && err.message ? err.message : String(err));
  }

  // General Event Listeners
  btnSendMessage.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (mentionActive) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionSelectedIndex = Math.min(mentionSelectedIndex + 1, mentionCurrentResults.length - 1);
        renderMentionDropdown();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionSelectedIndex = Math.max(mentionSelectedIndex - 1, 0);
        renderMentionDropdown();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (mentionCurrentResults.length > 0) {
          e.preventDefault();
          selectMention(mentionCurrentResults[mentionSelectedIndex]);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMentionDropdown();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Typing indicator: throttled so a fast typist emits ~1 event per 1.5 s
  // instead of one socket message (fanned out to the whole room) per keystroke.
  let lastTypingEmit = 0;
  let wasTyping = false;
  chatInput.addEventListener('input', () => {
    if (socket && socket.connected && currentTextRoom) {
      const hasText = chatInput.value.trim().length > 0;
      const now = Date.now();
      if (hasText) {
        if (now - lastTypingEmit > 1500) {
          lastTypingEmit = now;
          socket.emit('typing', { roomId: currentTextRoom });
        }
        wasTyping = true;
      } else if (wasTyping) {
        wasTyping = false;
        lastTypingEmit = 0;
        socket.emit('stop-typing', { roomId: currentTextRoom });
      }
    }
    handleMentionInput();
  });

  chatInput.addEventListener('click', handleMentionInput);
  chatInput.addEventListener('blur', () => {
    // Delay closing so a click on a dropdown item can register first
    setTimeout(closeMentionDropdown, 150);
  });

  // Passive + rAF-gated: the handler must never delay the scroll itself.
  let scrollCheckQueued = false;
  messagesContainer?.addEventListener('scroll', () => {
    if (scrollCheckQueued) return;
    scrollCheckQueued = true;
    requestAnimationFrame(() => {
      scrollCheckQueued = false;
      isPinnedToBottom = revealInProgress || distanceFromBottom() <= PINNED_TO_BOTTOM_PX;
      if (isPinnedToBottom) {
        hideNewMessagesPill();
        scheduleTrimRenderedMessages();
      }
      // Fetch the next page while a screen of history is still left above, so
      // a steady scroll never runs into the top and has to wait there.
      if (revealInProgress || messagesContainer.scrollTop > messagesContainer.clientHeight) return;
      if (isLoadingOlderMessages || !currentTextRoom || reachedOldestMessage.has(String(currentTextRoom))) return;
      const firstMsgElem = messagesContainer.querySelector('.message-item[data-msg-id]');
      if (firstMsgElem && firstMsgElem.dataset.msgId && socket && socket.connected) {
        isLoadingOlderMessages = true;
        socket.emit('get-older-messages', {
          roomId: currentTextRoom,
          beforeId: parseInt(firstMsgElem.dataset.msgId, 10)
        });
      }
    });
  }, { passive: true });

  // Grabbing the wheel or a finger during the channel-switch glide hands the
  // list back to the reader instead of snapping them to the bottom afterwards.
  const endReveal = () => {
    if (!revealInProgress) return;
    revealInProgress = false;
    clearTimeout(revealSnapTimer);
  };
  messagesContainer?.addEventListener('wheel', endReveal, { passive: true });
  messagesContainer?.addEventListener('touchstart', endReveal, { passive: true });

  // The list's own box shrinks when the typing indicator, reply bar or image
  // preview opens below it - a reader at the bottom has to stay there.
  if (messagesContainer) {
    new ResizeObserver(() => {
      stickToBottomIfPinned();
      positionNewMessagesPill();
    }).observe(messagesContainer);
  }
  // Images whose size isn't known up front (GIF links) still grow on load.
  messagesContainer?.addEventListener('load', (e) => {
    if (e.target && e.target.tagName === 'IMG') stickToBottomIfPinned();
  }, true);

  // Delegated so it keeps working after a message's reaction bar is
  // re-rendered in place (reaction-updated below) or a new message is
  // appended, instead of needing to re-wire listeners on every render.
  messagesContainer?.addEventListener('click', (e) => {
    const pill = e.target.closest('.reaction-pill');
    if (pill) {
      const msgItem = pill.closest('.message-item[data-msg-id]');
      if (msgItem && socket) {
        socket.emit('toggle-reaction', {
          messageId: parseInt(msgItem.dataset.msgId, 10),
          roomId: currentTextRoom,
          emoji: pill.dataset.emoji
        });
      }
      return;
    }
    const reactBtn = e.target.closest('.btn-react-msg');
    if (reactBtn) {
      openReactionPicker(reactBtn);
    }
  });

  document.querySelectorAll('.reaction-picker-emoji').forEach(btn => {
    btn.addEventListener('click', () => {
      if (reactionPickerTargetMsgId && socket) {
        socket.emit('toggle-reaction', {
          messageId: parseInt(reactionPickerTargetMsgId, 10),
          roomId: currentTextRoom,
          emoji: btn.dataset.emoji
        });
      }
      closeReactionPicker();
    });
  });

  document.addEventListener('click', (e) => {
    const popup = document.getElementById('reaction-picker-popup');
    if (popup && !popup.classList.contains('hidden') && !popup.contains(e.target) && !e.target.closest('.btn-react-msg')) {
      closeReactionPicker();
    }
  });

  const unlockAudioPolicy = () => {
    const container = document.getElementById('remote-audio-container');
    if (container) {
      container.querySelectorAll('audio').forEach(audio => {
        if (audio.paused && audio.srcObject) {
          audio.play().catch(() => {});
        }
      });
    }
  };
  window.addEventListener('click', unlockAudioPolicy, { passive: true });
  window.addEventListener('touchstart', unlockAudioPolicy, { passive: true });

  initMobileNavigation();

  // Members panel toggle. On narrow screens the panel is an overlay drawer,
  // so the same button slides it in instead of collapsing a column.
  btnToggleMembers?.addEventListener('click', () => {
    if (isCompactLayout()) {
      onlineUsersPanel?.classList.remove('hidden');
      membersVisible = true;
      setDrawer('members', !document.body.classList.contains('members-open'));
      return;
    }
    membersVisible = !membersVisible;
    onlineUsersPanel?.classList.toggle('hidden', !membersVisible);
    btnToggleMembers?.classList.toggle('active', membersVisible);
  });

  // Character counter for Bio
  if (inputBio && bioCharCounter) {
    inputBio.addEventListener('input', () => {
      bioCharCounter.textContent = `${inputBio.value.length} / 190`;
    });
  }

  // Character counter for custom status
  if (inputStatus && statusCharCounter) {
    inputStatus.addEventListener('input', () => {
      statusCharCounter.textContent = `${inputStatus.value.length} / 60`;
    });
  }

  // --- Appearance tab: accent color, compact mode, font size ---
  const accentSwatches = document.querySelectorAll('.accent-swatch[data-color]');
  const inputCustomAccent = document.getElementById('input-custom-accent');
  const savedAccentColor = localStorage.getItem('anucvc_accent_color');

  const markActiveSwatch = (color) => {
    accentSwatches.forEach(sw => sw.classList.toggle('active', sw.dataset.color.toLowerCase() === (color || '').toLowerCase()));
  };
  markActiveSwatch(savedAccentColor);

  accentSwatches.forEach(swatch => {
    swatch.addEventListener('click', () => {
      applyAccentColor(swatch.dataset.color, swatch.dataset.gradientTo);
      markActiveSwatch(swatch.dataset.color);
      if (inputCustomAccent) inputCustomAccent.value = swatch.dataset.color;
    });
  });

  if (inputCustomAccent) {
    if (savedAccentColor) inputCustomAccent.value = savedAccentColor;
    inputCustomAccent.addEventListener('input', (e) => {
      applyAccentColor(e.target.value);
      markActiveSwatch(null); // no preset swatch matches a free-picked color
    });
  }

  const toggleCompactMode = document.getElementById('toggle-compact-mode');
  if (toggleCompactMode) {
    toggleCompactMode.checked = localStorage.getItem('anucvc_compact_mode') === 'true';
    toggleCompactMode.addEventListener('change', (e) => {
      localStorage.setItem('anucvc_compact_mode', e.target.checked);
      document.body.classList.toggle('compact-mode', e.target.checked);
    });
  }

  const fontSizeButtons = document.querySelectorAll('.font-size-btn[data-size]');
  const savedFontSize = localStorage.getItem('anucvc_font_size') || 'medium';
  fontSizeButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === savedFontSize);
    btn.addEventListener('click', () => {
      fontSizeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      localStorage.setItem('anucvc_font_size', btn.dataset.size);
      applyFontSizeClass(btn.dataset.size);
    });
  });

  // Dismiss popover on document click or Escape key
  document.addEventListener('click', (e) => {
    if (userProfilePopover && !userProfilePopover.contains(e.target) && !e.target.closest('.member-item') && !e.target.closest('.msg-username') && !e.target.closest('.msg-avatar-small') && !e.target.closest('.friends-online-mini-card')) {
      userProfilePopover.classList.add('hidden');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (userProfilePopover) userProfilePopover.classList.add('hidden');
      if (nicknameModal) nicknameModal.classList.add('hidden');
    }
  });

  // User Context Menu Actions
  userCtxMuteNotif?.addEventListener('click', () => {
    if (!targetUserForAction || !targetUserForAction.username) return;
    const key = targetUserForAction.username.toLowerCase();
    if (mutedUsers[key]) {
      delete mutedUsers[key];
    } else {
      mutedUsers[key] = true;
    }
    saveUserPrefsToStorage();
    userContextMenu.classList.add('hidden');
    if (lastOnlineData) renderOnlineUsers(lastOnlineData);
  });

  const userCtxEditProfile = document.getElementById('user-ctx-edit-profile');
  userCtxEditProfile?.addEventListener('click', () => {
    userContextMenu.classList.add('hidden');
    btnSettings?.click();
  });

  userCtxSetNickname?.addEventListener('click', () => {
    if (!targetUserForAction || !targetUserForAction.username) return;
    userContextMenu.classList.add('hidden');
    const key = targetUserForAction.username.toLowerCase();
    inputNickname.value = userNicknames[key] || '';
    nicknameModal.classList.remove('hidden');
    inputNickname.focus();
  });

  btnCancelNickname?.addEventListener('click', () => {
    nicknameModal.classList.add('hidden');
  });

  btnSaveNickname?.addEventListener('click', () => {
    if (!targetUserForAction || !targetUserForAction.username) return;
    const key = targetUserForAction.username.toLowerCase();
    const val = inputNickname.value.trim();
    if (val) {
      userNicknames[key] = val;
    } else {
      delete userNicknames[key];
    }
    saveUserPrefsToStorage();
    nicknameModal.classList.add('hidden');
    if (lastOnlineData) renderOnlineUsers(lastOnlineData);
    scheduleChannelListRender();
  });

  const userCtxAdminDeleteUser = document.getElementById('user-ctx-admin-delete-user');
  const adminDeleteUserModal = document.getElementById('admin-delete-user-modal');
  const adminDeleteTargetUsername = document.getElementById('admin-delete-target-username');
  const btnCancelAdminDelete = document.getElementById('btn-cancel-admin-delete');
  const btnConfirmAdminDelete = document.getElementById('btn-confirm-admin-delete');

  let pendingAdminDeleteUsername = null;

  userCtxAdminDeleteUser?.addEventListener('click', () => {
    userContextMenu.classList.add('hidden');
    if (!targetUserForAction || !targetUserForAction.username) return;
    pendingAdminDeleteUsername = targetUserForAction.username;

    if (adminDeleteTargetUsername) {
      adminDeleteTargetUsername.textContent = pendingAdminDeleteUsername;
    }
    if (adminDeleteUserModal) {
      adminDeleteUserModal.classList.remove('hidden');
    }
  });

  btnCancelAdminDelete?.addEventListener('click', () => {
    if (adminDeleteUserModal) adminDeleteUserModal.classList.add('hidden');
    pendingAdminDeleteUsername = null;
  });

  btnConfirmAdminDelete?.addEventListener('click', () => {
    if (pendingAdminDeleteUsername) {
      socket.emit('delete-user-by-admin', { targetUsername: pendingAdminDeleteUsername });
    }
    if (adminDeleteUserModal) adminDeleteUserModal.classList.add('hidden');
    pendingAdminDeleteUsername = null;
  });

  const userCtxAddFriend = document.getElementById('user-ctx-add-friend');
  userCtxAddFriend?.addEventListener('click', () => {
    userContextMenu.classList.add('hidden');
    if (!targetUserForAction || !targetUserForAction.username) return;
    if (socket) {
      socket.emit('send-friend-request', { targetUsername: targetUserForAction.username });
    }
  });

  const userCtxSendDm = document.getElementById('user-ctx-send-dm');
  userCtxSendDm?.addEventListener('click', () => {
    userContextMenu.classList.add('hidden');
    if (!targetUserForAction || !targetUserForAction.username) return;
    const cachedUser = allUsersCache.find(u => (u.username || '').toLowerCase() === targetUserForAction.username.toLowerCase());
    if (cachedUser && cachedUser.id && socket) {
      socket.emit('get-or-create-dm', { targetUserId: cachedUser.id });
    }
  });

  const userCtxRemoveFriend = document.getElementById('user-ctx-remove-friend');
  userCtxRemoveFriend?.addEventListener('click', () => {
    userContextMenu.classList.add('hidden');
    if (!targetUserForAction || !targetUserForAction.username) return;
    const targetUname = targetUserForAction.username;
    const friendObj = myFriendsList.find(f => (f.username || '').toLowerCase() === targetUname.toLowerCase());
    if (friendObj && socket) {
      socket.emit('remove-friend', { friendId: friendObj.id });
    }
  });

  // Settings tab switching
  document.querySelectorAll('.settings-tab[data-tab]').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab[data-tab]').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
      tabBtn.classList.add('active');
      const targetTab = document.getElementById(tabBtn.dataset.tab);
      if (targetTab) targetTab.classList.add('active');
    });
  });

  // Audio processing toggles
  const toggleNS = document.getElementById('toggle-noise-suppression');
  const toggleEC = document.getElementById('toggle-echo-cancel');
  const toggleAG = document.getElementById('toggle-auto-gain');
  const toggleNotifSound = document.getElementById('toggle-notification-sound');
  const togglePTT = document.getElementById('toggle-push-to-talk');
  const selectScreenQuality = document.getElementById('select-screen-quality');

  // Load saved preferences
  if (toggleNS) toggleNS.checked = localStorage.getItem('anucvc_noise_suppression') !== 'false';
  if (toggleEC) toggleEC.checked = localStorage.getItem('anucvc_echo_cancel') !== 'false';
  if (toggleAG) toggleAG.checked = localStorage.getItem('anucvc_auto_gain') !== 'false';
  if (toggleNotifSound) toggleNotifSound.checked = localStorage.getItem('anucvc_notif_sound') !== 'false';
  if (togglePTT) togglePTT.checked = localStorage.getItem('anucvc_ptt_enabled') === 'true';
  if (selectScreenQuality) selectScreenQuality.value = localStorage.getItem('anucvc_screen_quality') || '720p_30';

  toggleNS?.addEventListener('change', (e) => {
    localStorage.setItem('anucvc_noise_suppression', e.target.checked);
    if (voiceManager) voiceManager.updateAudioProcessing();
  });
  toggleEC?.addEventListener('change', (e) => {
    localStorage.setItem('anucvc_echo_cancel', e.target.checked);
    if (voiceManager) voiceManager.updateAudioProcessing();
  });
  toggleAG?.addEventListener('change', (e) => {
    localStorage.setItem('anucvc_auto_gain', e.target.checked);
    if (voiceManager) voiceManager.updateAudioProcessing();
  });
  toggleNotifSound?.addEventListener('change', (e) => {
    localStorage.setItem('anucvc_notif_sound', e.target.checked);
  });
  togglePTT?.addEventListener('change', (e) => {
    if (e.target.checked && !keyboardShortcuts.pushToTalk) {
      showToast('Önce Kısayollar sekmesinden Bas-Konuş için bir tuş atamalısınız.', 'error');
      e.target.checked = false;
      return;
    }
    localStorage.setItem('anucvc_ptt_enabled', e.target.checked);
    if (voiceManager) voiceManager.setPushToTalkMode(e.target.checked);
  });

  // Notification volume slider - lives inside the same settings bubble as
  // the toggle above. Live-updates the percentage label while dragging;
  // only plays a preview once the user actually lets go of it (a preview on
  // every 'input' tick while dragging would just be noise, and would fight
  // the 150ms replay-throttle in playAppNotificationSound anyway).
  const inputNotifVolume = document.getElementById('input-notif-volume');
  const txtNotifVolumeVal = document.getElementById('txt-notif-volume-val');
  if (inputNotifVolume) {
    const savedVol = localStorage.getItem('anucvc_notif_volume');
    inputNotifVolume.value = savedVol === null ? 70 : savedVol;
    if (txtNotifVolumeVal) txtNotifVolumeVal.textContent = `${inputNotifVolume.value}%`;

    inputNotifVolume.addEventListener('input', (e) => {
      if (txtNotifVolumeVal) txtNotifVolumeVal.textContent = `${e.target.value}%`;
    });
    inputNotifVolume.addEventListener('change', (e) => {
      localStorage.setItem('anucvc_notif_volume', e.target.value);
      playAppNotificationSound(0.35);
    });
  }
  selectScreenQuality?.addEventListener('change', (e) => {
    localStorage.setItem('anucvc_screen_quality', e.target.value);
  });

  // Keyboard shortcuts settings
  const shortcutActions = ['pushToTalk', 'toggleMic', 'toggleDeafen', 'toggleCamera', 'stopScreenShare'];
  shortcutActions.forEach(action => {
    const btn = document.getElementById(`shortcut-btn-${action}`);
    if (btn) btn.textContent = formatShortcutLabel(keyboardShortcuts[action]);
  });

  document.querySelectorAll('.shortcut-keybind-btn').forEach(btn => {
    btn.addEventListener('click', () => startRecordingShortcut(btn, btn.dataset.action));
  });

  document.querySelectorAll('.shortcut-clear-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      delete keyboardShortcuts[action];
      saveKeyboardShortcuts();
      const keybindBtn = document.getElementById(`shortcut-btn-${action}`);
      if (keybindBtn) keybindBtn.textContent = 'Atanmadı';

      // Clearing the PTT keybind while the mode is on would leave the mic
      // stuck silent with no way to talk - turn the mode off along with it.
      if (action === 'pushToTalk' && togglePTT && togglePTT.checked) {
        togglePTT.checked = false;
        localStorage.setItem('anucvc_ptt_enabled', 'false');
        if (voiceManager) voiceManager.setPushToTalkMode(false);
        showToast('Bas-Konuş kısayolu kaldırıldığı için mod kapatıldı.', 'error');
      }
    });
  });

  // Image Upload Handlers
  btnAttachImage?.addEventListener('click', () => {
    imageFileInput.click();
  });

  imageFileInput?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      selectedImageData = await compressAndResizeImage(file);
      imagePreviewThumb.src = selectedImageData;
      imagePreviewBar.classList.remove('hidden');
    } catch (err) {
      console.error('Görsel işleme hatası:', err);
    }
  });

  btnRemoveImage?.addEventListener('click', () => {
    clearSelectedImage();
  });

  btnCancelReply?.addEventListener('click', () => {
    cancelReply();
  });

  btnCloseLightbox?.addEventListener('click', () => {
    imageLightboxModal.classList.add('hidden');
  });

  imageLightboxModal?.addEventListener('click', (e) => {
    if (e.target === imageLightboxModal) {
      imageLightboxModal.classList.add('hidden');
    }
  });

  btnToggleMic.addEventListener('click', () => {
    if (voiceManager) {
      const isMuted = voiceManager.toggleMute();
      syncMicDeafenButtonsUI(isMuted, voiceManager.isDeafened);
      updateVoiceGrid();
    }
  });

  btnToggleDeaf.addEventListener('click', () => {
    if (voiceManager) {
      const isDeafened = voiceManager.toggleDeafen();
      syncMicDeafenButtonsUI(voiceManager.isMuted, isDeafened);
      updateVoiceGrid();
    }
  });

let statsInterval = null;

function stopSystemStatsPolling() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

function formatServerUptime(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} gün ${h} sa`;
  if (h > 0) return `${h} sa ${m} dk`;
  return `${m} dk`;
}

function formatMemMB(mb) {
  if (typeof mb !== 'number') return '—';
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`;
}

// Meters go green -> amber -> red as pressure rises, so a glance is enough.
function setMeter(barId, pctValue) {
  const bar = document.getElementById(barId);
  if (!bar) return;
  const p = Math.max(0, Math.min(100, Number(pctValue) || 0));
  bar.style.width = `${p}%`;
  bar.classList.toggle('is-warn', p >= 50 && p < 80);
  bar.classList.toggle('is-crit', p >= 80);
}

const setStatText = (id, text) => {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
};

async function fetchSystemStats() {
  const isAdmin = currentUser && currentUser.role === 'admin';
  const adminSystemInfo = document.getElementById('admin-system-info');
  if (!adminSystemInfo || !isAdmin) return;
  // Don't keep polling a panel nobody is looking at.
  if (settingsModal && settingsModal.classList.contains('hidden')) return;

  try {
    const res = await fetch(`${serverUrl}/api/system/stats`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const data = await res.json();
    if (!res.ok || !data.success) return;

    // Whole-device RAM
    if (typeof data.systemUsedMB === 'number') {
      setStatText('info-system-ram', `${formatMemMB(data.systemUsedMB)} / ${formatMemMB(data.systemTotalMB)}`);
      setStatText('info-system-ram-pct', `%${(data.systemRamPercent ?? 0).toFixed(1)}`);
      setMeter('info-system-ram-bar', data.systemRamPercent);
      setStatText('info-system-ram-hint', `Boşta ${formatMemMB(data.systemFreeMB)}`);
    }

    setStatText('info-cpu', typeof data.cpuPercent === 'number' ? `%${data.cpuPercent.toFixed(1)}` : '—');
    setMeter('info-cpu-bar', data.cpuPercent);

    setStatText('info-db-size', data.dbSize || '—');
    setStatText('info-uptime', formatServerUptime(data.uptimeSeconds));
  } catch (e) {
    console.error('Fetch system stats error:', e);
  }
}

  const selectMicDevice = document.getElementById('select-mic-device');
  const selectOutputDevice = document.getElementById('select-output-device');

  async function populateAudioDeviceSelects() {
    if (!voiceManager || !selectMicDevice || !selectOutputDevice) return;

    try {
      const { inputs, outputs } = await voiceManager.getAudioDevices();

      // Populate Input Devices (Microphones)
      selectMicDevice.innerHTML = '<option value="">Varsayılan Mikrofon</option>';
      inputs.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Mikrofon ${index + 1}`;
        if (voiceManager.selectedInputId === device.deviceId) {
          option.selected = true;
        }
        selectMicDevice.appendChild(option);
      });

      // Populate Output Devices (Headsets / Speakers)
      selectOutputDevice.innerHTML = '<option value="">Varsayılan Kulaklık / Hoparlör</option>';
      outputs.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Hoparlör / Kulaklık ${index + 1}`;
        if (voiceManager.selectedOutputId === device.deviceId) {
          option.selected = true;
        }
        selectOutputDevice.appendChild(option);
      });
    } catch (e) {
      console.error('Error populating audio devices:', e);
    }
  }

  selectMicDevice?.addEventListener('change', (e) => {
    if (voiceManager) {
      voiceManager.setAudioInputDevice(e.target.value);
    }
  });

  selectOutputDevice?.addEventListener('change', (e) => {
    if (voiceManager) {
      voiceManager.setAudioOutputDevice(e.target.value);
    }
  });

  // Settings modal & Avatar picker
  document.getElementById('btn-close-settings')?.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
    stopSystemStatsPolling();
  });

  btnSettings?.addEventListener('click', async () => {
    inputUsername.value = username;
    if (inputBio) inputBio.value = currentUser ? (currentUser.bio || '') : '';
    if (bioCharCounter) bioCharCounter.textContent = `${(inputBio ? inputBio.value : '').length} / 190`;
    if (inputStatus) inputStatus.value = currentUser ? (currentUser.status || '') : '';
    if (statusCharCounter) statusCharCounter.textContent = `${(inputStatus ? inputStatus.value : '').length} / 60`;

    pendingAvatarDataUrl = userAvatar;
    pendingBannerDataUrl = currentUser ? (currentUser.banner || null) : null;

    if (userAvatar) {
      settingsAvatarImg.src = userAvatar;
      settingsAvatarImg.classList.remove('hidden');
      settingsAvatarInitial.classList.add('hidden');
    } else {
      settingsAvatarImg.classList.add('hidden');
      settingsAvatarInitial.textContent = username.charAt(0).toUpperCase();
      settingsAvatarInitial.classList.remove('hidden');
    }

    if (settingsBannerImg) {
      if (pendingBannerDataUrl) {
        settingsBannerImg.style.backgroundImage = `url(${pendingBannerDataUrl})`;
      } else {
        settingsBannerImg.style.backgroundImage = '';
      }
    }

    // Populate Connected Audio Input / Output Devices
    await populateAudioDeviceSelects();

    // Admin Server RAM & Database Size Info
    const isAdmin = currentUser && currentUser.role === 'admin';
    const adminSystemInfo = document.getElementById('admin-system-info');
    const adminNoAccess = document.getElementById('admin-no-access');
    const settingsTabSystemBtn = document.getElementById('settings-tab-system');

    if (settingsTabSystemBtn) {
      settingsTabSystemBtn.classList.toggle('hidden', !isAdmin);
    }

    if (isAdmin) {
      if (adminSystemInfo) adminSystemInfo.classList.remove('hidden');
      if (adminNoAccess) adminNoAccess.classList.add('hidden');
      stopSystemStatsPolling();
      settingsModal.classList.remove('hidden'); // so the first poll isn't skipped
      await fetchSystemStats();
      statsInterval = setInterval(fetchSystemStats, 3000);
    } else {
      if (adminSystemInfo) adminSystemInfo.classList.add('hidden');
      if (adminNoAccess) adminNoAccess.classList.remove('hidden');
    }

    // Reset to profile tab
    document.querySelectorAll('.settings-tab[data-tab]').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('.settings-tab[data-tab="tab-profile"]')?.classList.add('active');
    document.getElementById('tab-profile')?.classList.add('active');

    const profileErrorBadge = document.getElementById('settings-profile-error');
    if (profileErrorBadge) profileErrorBadge.classList.add('hidden');

    settingsModal.classList.remove('hidden');
  });

  settingsAvatarPreview.addEventListener('click', () => {
    inputAvatarFile.click();
  });

  inputAvatarFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    openAvatarCropper(file);
  });
  const inputVadSensitivity = document.getElementById('input-vad-sensitivity');
  const txtVadSensitivityVal = document.getElementById('txt-vad-sensitivity-val');
  const vadLiveFill = document.getElementById('vad-live-fill');
  const vadThresholdMarker = document.getElementById('vad-threshold-marker');

  const updateSensitivityUI = (val) => {
    // Not decibels: this is the 0-100 relative loudness the VAD compares
    // against (see getSpeechVolume in webrtc.js), so labelling it "dB" was
    // just wrong - a "35 dB" threshold means nothing to anyone reading it.
    if (txtVadSensitivityVal) txtVadSensitivityVal.textContent = `%${val}`;
    if (vadThresholdMarker) {
      const pct = Math.min(100, Math.max(0, ((val - 5) / 75) * 100));
      vadThresholdMarker.style.left = `${pct}%`;
    }
  };

  const savedSens = localStorage.getItem('anucvc_vad_sensitivity') || '35';
  if (inputVadSensitivity) {
    inputVadSensitivity.value = savedSens;
    updateSensitivityUI(savedSens);

    inputVadSensitivity.addEventListener('input', (e) => {
      const val = e.target.value;
      updateSensitivityUI(val);
      if (voiceManager) {
        voiceManager.setVadSensitivity(val);
      }
    });
  }

  btnTestMic?.addEventListener('click', async () => {
    if (voiceManager && voiceManager.isTestingMic) {
      stopMicTestUI();
    } else if (voiceManager) {
      const started = await voiceManager.startMicTest((volume) => {
        const currentSens = parseInt(inputVadSensitivity?.value || '35', 10);

        if (micTestVisualizer) {
          const bars = micTestVisualizer.querySelectorAll('.mic-test-bar');
          bars.forEach((bar, idx) => {
            const h = Math.min(20, Math.max(4, (volume / (idx + 1)) * 1.5));
            bar.style.height = `${h}px`;
            if (volume > currentSens) {
              bar.style.backgroundColor = '#23a55a';
            } else {
              bar.style.backgroundColor = 'var(--accent-color)';
            }
          });
        }
        if (vadLiveFill) {
          const fillPct = Math.min(100, Math.max(0, volume));
          vadLiveFill.style.width = `${fillPct}%`;
          if (volume > currentSens) {
            vadLiveFill.style.backgroundColor = '#23a55a';
          } else {
            vadLiveFill.style.backgroundColor = '#f23f43';
          }
        }
      });

      if (started) {
        btnTestMic.classList.add('testing');
        if (txtTestMic) txtTestMic.textContent = 'Testi Durdur';
        if (iconPlay) iconPlay.classList.add('hidden');
        if (iconStop) iconStop.classList.remove('hidden');
        if (micTestVisualizer) micTestVisualizer.classList.remove('hidden');
      } else {
        showAppAlert('Mikrofona erişilemedi. Lütfen tarayıcı izinlerini kontrol edin.', 'Mikrofon Hatası');
      }
    }
  });

  btnSaveSettings.addEventListener('click', async () => {
    stopMicTestUI();
    const newName = inputUsername.value.trim();
    const profileErrorBadge = document.getElementById('settings-profile-error');
    const txtProfileError = document.getElementById('txt-profile-error');
    if (profileErrorBadge) profileErrorBadge.classList.add('hidden');

    if (!newName) return;

    btnSaveSettings.disabled = true;
    btnSaveSettings.textContent = 'Kaydediliyor...';

    try {
      const res = await fetch(`${serverUrl}/api/auth/update-profile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
          username: newName,
          avatar: pendingAvatarDataUrl,
          bio: inputBio ? inputBio.value.trim() : '',
          banner: pendingBannerDataUrl,
          status: inputStatus ? inputStatus.value.trim() : ''
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        username = data.user.username;
        userAvatar = data.user.avatar;
        if (currentUser) {
          currentUser.username = username;
          currentUser.avatar = userAvatar;
          currentUser.bio = data.user.bio || '';
          currentUser.banner = data.user.banner || null;
          currentUser.status = data.user.status || '';
          localStorage.setItem('anucvc_user', JSON.stringify(currentUser));
        }
        localStorage.setItem('anucvc_username', username);

        updateUserDisplay();

        refreshRenderedAuthor(username, userAvatar);

        if (socket) socket.emit('set-username', { token: authToken });
        settingsModal.classList.add('hidden');
    stopSystemStatsPolling();
      } else {
        if (profileErrorBadge && txtProfileError) {
          txtProfileError.textContent = data.error || 'Bu isimde bir AnucVC kullanıcısı var';
          profileErrorBadge.classList.remove('hidden');
        }
      }
    } catch (err) {
      console.error('Update profile error:', err);
    } finally {
      btnSaveSettings.disabled = false;
      btnSaveSettings.textContent = 'Kaydet';
    }
  });

  // Change Password Event Listeners
  btnOpenChangePassword?.addEventListener('click', () => {
    inputOldPw.value = '';
    inputNewPw.value = '';
    inputConfirmNewPw.value = '';
    changePwError.classList.add('hidden');
    settingsModal.classList.add('hidden');
    stopSystemStatsPolling();
    changePasswordModal.classList.remove('hidden');
  });

  btnCloseChangePw?.addEventListener('click', () => {
    changePasswordModal.classList.add('hidden');
  });

  btnCancelChangePw?.addEventListener('click', () => {
    changePasswordModal.classList.add('hidden');
  });

  btnSaveChangePw?.addEventListener('click', async () => {
    changePwError.classList.add('hidden');

    const oldPw = inputOldPw.value;
    const newPw = inputNewPw.value;
    const confirmPw = inputConfirmNewPw.value;

    if (!oldPw) {
      showChangePwError('Lütfen mevcut şifrenizi giriniz.');
      return;
    }

    if (!newPw || newPw.length < 6) {
      showChangePwError('Yeni şifreniz en az 6 karakter olmalıdır.');
      return;
    }

    if (newPw !== confirmPw) {
      showChangePwError('Yeni şifreler birbiriyle uyuşmuyor.');
      return;
    }

    btnSaveChangePw.disabled = true;
    btnSaveChangePw.textContent = 'Güncelleniyor...';

    try {
      const res = await fetch(`${serverUrl}/api/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        // A password change revokes every older session token, this one
        // included - switch to the fresh one the server handed back.
        if (data.token) {
          authToken = data.token;
          localStorage.setItem('anucvc_token', authToken);
          if (socket) socket.emit('set-username', { token: authToken });
        }
        showAppAlert('Şifreniz başarıyla değiştirildi!', 'Başarılı');
        changePasswordModal.classList.add('hidden');
      } else {
        showChangePwError(data.error || 'Şifre değiştirilemedi.');
      }
    } catch (err) {
      console.error('Change password error:', err);
      showChangePwError('Sunucu hatası oluştu.');
    } finally {
      btnSaveChangePw.disabled = false;
      btnSaveChangePw.textContent = 'Şifreyi Güncelle';
    }
  });

  // Logout from Settings Modal
  btnLogoutSettings?.addEventListener('click', () => {
    stopMicTestUI();
    settingsModal.classList.add('hidden');
    stopSystemStatsPolling();
    confirmActionType = 'logout';
    confirmModalTitle.textContent = 'Çıkış Yap';
    confirmModalText.textContent = 'Oturumunuzu kapatmak istediğinizden emin misiniz?';
    btnAcceptConfirm.textContent = 'Evet, Çıkış Yap';
    confirmModal.classList.remove('hidden');
  });

  // Avatar Cropper Handlers
  cropZoomRange.addEventListener('input', (e) => {
    cropZoom = parseFloat(e.target.value);
    drawCropCanvas();
  });

  const cropperContainer = document.querySelector('.cropper-container');
  // The canvas's logical drawing space (cropCanvas.width, fixed at 260) can
  // now render smaller than that on a narrow screen (CSS scales it down to
  // fit) - without correcting for that, a drag would move the image further
  // than the mouse actually traveled on screen.
  cropperContainer.addEventListener('mousedown', (e) => {
    isDraggingCrop = true;
    const scale = cropCanvas.width / cropperContainer.getBoundingClientRect().width;
    dragStartX = e.clientX * scale - cropOffsetX;
    dragStartY = e.clientY * scale - cropOffsetY;
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDraggingCrop) return;
    const scale = cropCanvas.width / cropperContainer.getBoundingClientRect().width;
    cropOffsetX = e.clientX * scale - dragStartX;
    cropOffsetY = e.clientY * scale - dragStartY;
    drawCropCanvas();
  });

  window.addEventListener('mouseup', () => {
    isDraggingCrop = false;
  });

  btnCancelCrop.addEventListener('click', () => {
    avatarCropModal.classList.add('hidden');
  });

  btnApplyCrop.addEventListener('click', () => {
    applyAvatarCrop();
  });

  // Banner Cropper Handlers & Listeners
  settingsBannerPreview?.addEventListener('click', () => {
    inputBannerFile?.click();
  });

  inputBannerFile?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    openBannerCropper(file);
  });

  bannerCropZoomRange?.addEventListener('input', (e) => {
    bannerCropZoom = parseFloat(e.target.value);
    drawBannerCropCanvas();
  });

  const bannerCropperContainer = document.querySelector('.banner-cropper-container');
  // Same scale correction as the avatar cropper above - the banner canvas's
  // logical space (520x160) can render smaller than that on a narrow screen.
  bannerCropperContainer?.addEventListener('mousedown', (e) => {
    isDraggingBannerCrop = true;
    const scale = bannerCropCanvas.width / bannerCropperContainer.getBoundingClientRect().width;
    bannerDragStartX = e.clientX * scale - bannerCropOffsetX;
    bannerDragStartY = e.clientY * scale - bannerCropOffsetY;
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDraggingBannerCrop) return;
    const scale = bannerCropCanvas.width / bannerCropperContainer.getBoundingClientRect().width;
    bannerCropOffsetX = e.clientX * scale - bannerDragStartX;
    bannerCropOffsetY = e.clientY * scale - bannerDragStartY;
    drawBannerCropCanvas();
  });

  window.addEventListener('mouseup', () => {
    isDraggingBannerCrop = false;
  });

  btnCancelBannerCrop?.addEventListener('click', () => {
    bannerCropModal?.classList.add('hidden');
  });

  btnApplyBannerCrop?.addEventListener('click', () => {
    applyBannerCrop();
  });

  // Add Channels
  btnAddTextChannel?.addEventListener('click', () => openCreateChannelModal('text'));
  btnAddVoiceChannel?.addEventListener('click', () => openCreateChannelModal('voice'));

  btnRenameChannel?.addEventListener('click', () => {
    openRenameChannelModal({ id: currentTextRoom, name: currentChannelNameElem.textContent });
  });

  btnCancelChannelModal.addEventListener('click', () => {
    channelModal.classList.add('hidden');
  });

  btnSaveChannelModal.addEventListener('click', saveChannelModalAction);
  inputChannelName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveChannelModalAction();
  });

  // Edit Message Modal Listeners
  btnCancelEditMsg?.addEventListener('click', () => {
    editMessageModal.classList.add('hidden');
  });
  btnSaveEditMsg?.addEventListener('click', saveEditMessageAction);
  inputEditMsg?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveEditMessageAction();
  });

  // Context Menu Events (Channel)
  ctxMuteChannel?.addEventListener('click', () => {
    contextMenu.classList.add('hidden');
    if (targetChannelForAction) {
      const id = targetChannelForAction.id;
      mutedChannels[id] = !mutedChannels[id];
      saveMutedChannelsToStorage();
      scheduleChannelListRender();
    }
  });

  ctxRename.addEventListener('click', () => {
    contextMenu.classList.add('hidden');
    if (targetChannelForAction) {
      openRenameChannelModal(targetChannelForAction);
    }
  });

  ctxDelete.addEventListener('click', () => {
    contextMenu.classList.add('hidden');
    if (targetChannelForAction) {
      confirmActionType = 'delete-channel';
      confirmModalTitle.textContent = 'Kanalı Sil';
      confirmModalText.textContent = `"${targetChannelForAction.name}" kanalını silmek istediğinizden emin misiniz?`;
      btnAcceptConfirm.textContent = 'Evet, Sil';
      confirmModal.classList.remove('hidden');
    }
  });

  // User Volume Context Menu Slider Event
  userCtxVolSlider?.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    if (ctxVolumeMode === 'screen') {
      if (targetStreamOwnerId) setStreamVolume(targetStreamOwnerId, val);
      return;
    }
    if (targetUserSocketIdForVol && voiceManager) {
      updateUserVolumeUI(targetUserSocketIdForVol, val);
    }
  });

  userCtxSpeakerBtn?.addEventListener('click', () => {
    if (!voiceManager) return;
    if (ctxVolumeMode === 'screen') {
      if (targetStreamOwnerId) toggleStreamMute(targetStreamOwnerId);
      return;
    }
    if (!targetUserSocketIdForVol) return;
    const peer = voiceManager.peers.get(targetUserSocketIdForVol);
    const currentVol = peer ? peer.volume : 1.0;

    if (currentVol > 0) {
      lastNonZeroVolumeMap[targetUserSocketIdForVol] = currentVol;
      updateUserVolumeUI(targetUserSocketIdForVol, 0);
    } else {
      const restoreVol = lastNonZeroVolumeMap[targetUserSocketIdForVol] || 1.0;
      updateUserVolumeUI(targetUserSocketIdForVol, restoreVol);
    }
  });

  userCtxStreamToggle?.addEventListener('click', () => {
    userContextMenu.classList.add('hidden');
    if (targetStreamOwnerId) toggleWatchingStream(targetStreamOwnerId);
  });

  btnCancelConfirm.addEventListener('click', () => {
    confirmModal.classList.add('hidden');
  });

  btnAcceptConfirm.addEventListener('click', () => {
    confirmModal.classList.add('hidden');
    if (confirmActionType === 'delete-channel') {
      if (targetChannelForAction && socket) {
        socket.emit('delete-channel', { roomId: targetChannelForAction.id });
      }
    } else if (confirmActionType === 'delete-message') {
      if (targetMessageForDelete && socket) {
        socket.emit('delete-message', {
          messageId: targetMessageForDelete.id,
          roomId: currentTextRoom
        });
      }
    } else if (confirmActionType === 'delete-user') {
      // Admin deleting a user
      if (targetUserForAction && targetUserForAction.username && socket) {
        socket.emit('delete-user-by-admin', { targetUsername: targetUserForAction.username });
      }
    } else if (confirmActionType === 'logout') {
      performLogout();
    }
  });

  // Account Deleted Modal handlers
  if (btnAccountDeletedOk) {
    btnAccountDeletedOk.addEventListener('click', () => {
      if (accountDeletedModal) accountDeletedModal.classList.add('hidden');
      localStorage.clear();
      // Reload to go back to login/register screen
      location.reload();
    });
  }

  document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) {
      contextMenu.classList.add('hidden');
    }
    if (!userContextMenu.contains(e.target)) {
      userContextMenu.classList.add('hidden');
    }
  });

  btnDisconnectVoice.addEventListener('click', disconnectVoice);
  btnCallLeave?.addEventListener('click', disconnectVoice);

  btnExpandCallView?.addEventListener('click', openCallView);
  btnMinimizeCallView?.addEventListener('click', closeCallView);

  const screenshareQualityMenu = document.getElementById('screenshare-quality-menu');

  btnCallScreenshare?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!voiceManager || !currentVoiceRoom) return;

    if (voiceManager.isScreenSharing) {
      voiceManager.stopScreenShare();
      forgetStream(LOCAL_STREAM_OWNER);
      if (screenshareQualityMenu) screenshareQualityMenu.classList.add('hidden');
      updateScreenShareButtonUI();
      updateVoiceGrid();
    } else {
      if (screenshareQualityMenu) {
        screenshareQualityMenu.classList.toggle('hidden');
      }
    }
  });

  // Quality options are rendered from SCREEN_QUALITY_PRESETS (webrtc.js) rather
  // than hardcoded in the markup, so the list and the getDisplayMedia
  // constraints can never drift apart.
  renderScreenQualityMenu();
  document.getElementById('screenshare-quality-list')?.addEventListener('click', async (e) => {
    const item = e.target.closest('.screenshare-menu-item');
    if (!item) return;
    e.stopPropagation();
    if (screenshareQualityMenu) screenshareQualityMenu.classList.add('hidden');
    if (!voiceManager || !currentVoiceRoom) return;

    const quality = item.dataset.quality || '720p_30';
    localStorage.setItem('anucvc_screen_quality', quality);
    renderScreenQualityMenu();

    btnCallScreenshare.disabled = true;
    const started = await voiceManager.startScreenShare();
    btnCallScreenshare.disabled = false;

    if (started) {
      // Your own share previews itself right away - it is the only way to
      // confirm you picked the window you meant to share.
      watchedStreams.add(LOCAL_STREAM_OWNER);
      updateScreenShareButtonUI();
      updateVoiceGrid();
    } else if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      showAppAlert('Bu ortamda ekran paylaşımı desteklenmiyor.', 'Ekran Paylaşımı');
    }
  });

  // Close screenshare quality dropdown on outside click
  document.addEventListener('click', (e) => {
    if (screenshareQualityMenu && !screenshareQualityMenu.contains(e.target) && e.target !== btnCallScreenshare) {
      screenshareQualityMenu.classList.add('hidden');
    }
  });

  btnCallCamera?.addEventListener('click', async () => {
    if (!voiceManager || !currentVoiceRoom) return;

    if (voiceManager.isCameraOn) {
      voiceManager.stopCamera();
      updateCameraButtonUI();
      updateVoiceGrid();
    } else {
      btnCallCamera.disabled = true;
      const started = await voiceManager.startCamera();
      btnCallCamera.disabled = false;
      if (started) {
        updateCameraButtonUI();
        updateVoiceGrid();
      } else if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        showAppAlert('Bu ortamda kamera desteklenmiyor.', 'Kamera Hatası');
      } else {
        showAppAlert('Kameraya erişilemedi. Lütfen tarayıcı/izin ayarlarını kontrol edin.', 'Kamera Hatası');
      }
    }
  });

  btnCallMic?.addEventListener('click', () => {
    if (voiceManager) {
      const isMuted = voiceManager.toggleMute();
      syncMicDeafenButtonsUI(isMuted, voiceManager.isDeafened);
      updateVoiceGrid();
    }
  });

  btnCallDeafen?.addEventListener('click', () => {
    if (voiceManager) {
      const isDeafened = voiceManager.toggleDeafen();
      syncMicDeafenButtonsUI(voiceManager.isMuted, isDeafened);
      updateVoiceGrid();
    }
  });

}

function openCallView() {
  if (!currentVoiceRoom || !callView) return;
  callViewOpen = true;
  callView.classList.remove('hidden');
  unreadWhileInCallView = 0;
  if (callViewUnreadBadge) callViewUnreadBadge.classList.add('hidden');
  updateVoiceGrid();
  // Tiles kept across the close/open cycle (same contentKey, so
  // updateVoiceGrid() just patches them instead of rebuilding) were paused
  // by closeCallView() below - resume them, since patchCallTile() never
  // touches playback state. Stream tiles are resumed by syncAllStreamTiles()
  // inside updateVoiceGrid() instead, so an un-watched share stays paused.
  callViewGrid?.querySelectorAll('.call-tile:not(.call-tile-stream) video').forEach(v => v.play().catch(() => {}));
}

function closeCallView() {
  if (!callView) return;
  callViewOpen = false;
  callView.classList.add('hidden');
  unreadWhileInCallView = 0;
  if (callViewUnreadBadge) callViewUnreadBadge.classList.add('hidden');
  // Minimizing the call view hides its tiles but leaves them in the DOM
  // (updateVoiceGrid() reuses them on reopen) with their camera/screen-share
  // <video> elements still attached to a live MediaStream - without this,
  // that video keeps decoding off-screen for as long as the peer's camera
  // or screen share stays on, for no visible benefit.
  callViewGrid?.querySelectorAll('video').forEach(v => v.pause());
}

// Minimizing/covering the whole app window (e.g. alt-tabbing to a game
// while a camera or screen share stays on in the call) doesn't touch
// callViewOpen or callView's own hidden class - without this, remote video
// tiles and the screen-share viewer keep decoding and painting frames that
// are, by definition, not on screen for as long as the window stays hidden.
document.addEventListener('visibilitychange', () => {
  const hidden = document.visibilityState === 'hidden';
  if (callViewOpen && callViewGrid) {
    callViewGrid.querySelectorAll('.call-tile:not(.call-tile-stream) video').forEach(v => (hidden ? v.pause() : v.play().catch(() => {})));
    syncAllStreamTiles();
  }
  // The pop-out window is deliberately left running: watching a stream in a
  // small always-on-top window while the app itself is hidden behind a game is
  // the entire point of it.
});

// Away status: closing the Tauri window to the tray (or just backgrounding a
// browser tab) keeps the socket connected, so without this a user who quit
// to the tray an hour ago still shows as green/online to everyone else. After
// AWAY_TIMEOUT_MS of staying hidden the server flips their roster dot to
// amber and sorts them to the bottom of the online list; coming back to the
// foreground clears it immediately.
const AWAY_TIMEOUT_MS = 60000;
let awayTimer = null;
let isMarkedAway = false;

function setAwayState(away) {
  if (isMarkedAway === away) return;
  isMarkedAway = away;
  if (socket && socket.connected) socket.emit('set-away', away);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (awayTimer) clearTimeout(awayTimer);
    awayTimer = setTimeout(() => setAwayState(true), AWAY_TIMEOUT_MS);
  } else {
    if (awayTimer) {
      clearTimeout(awayTimer);
      awayTimer = null;
    }
    setAwayState(false);
  }
});

function incrementCallViewUnread() {
  unreadWhileInCallView++;
  if (callViewUnreadBadge) {
    callViewUnreadBadge.textContent = unreadWhileInCallView > 99 ? '99+' : String(unreadWhileInCallView);
    callViewUnreadBadge.classList.remove('hidden');
  }
}

function syncMicDeafenButtonsUI(isMuted, isDeafened) {
  [btnToggleMic, btnCallMic].forEach(btn => {
    if (!btn) return;
    btn.classList.toggle('active-danger', isMuted);
    btn.classList.toggle('muted-off', isMuted);
    btn.querySelector('.mic-on-icon')?.classList.toggle('hidden', isMuted);
    btn.querySelector('.mic-off-icon')?.classList.toggle('hidden', !isMuted);
  });
  [btnToggleDeaf, btnCallDeafen].forEach(btn => {
    if (!btn) return;
    btn.classList.toggle('active-danger', isDeafened);
    btn.classList.toggle('muted-off', isDeafened);
    btn.querySelector('.deaf-on-icon')?.classList.toggle('hidden', isDeafened);
    btn.querySelector('.deaf-off-icon')?.classList.toggle('hidden', !isDeafened);
  });
}

const screenShareMonitorIconSvg = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';

function updateScreenShareButtonUI() {
  const sharing = !!(voiceManager && voiceManager.isScreenSharing);
  if (!btnCallScreenshare) return;
  const inSfuRoom = currentVoiceRoom === SFU_ROOM_ID;
  btnCallScreenshare.classList.toggle('active', sharing);
  btnCallScreenshare.disabled = inSfuRoom;
  btnCallScreenshare.title = inSfuRoom ? 'CS2 ROOM sadece ses içindir' : (sharing ? 'Yayını Durdur' : 'Ekranını Paylaş');
}

function updateCameraButtonUI() {
  const camOn = !!(voiceManager && voiceManager.isCameraOn);
  if (!btnCallCamera) return;
  const inSfuRoom = currentVoiceRoom === SFU_ROOM_ID;
  btnCallCamera.classList.toggle('active', camOn);
  btnCallCamera.disabled = inSfuRoom;
  btnCallCamera.title = inSfuRoom ? 'CS2 ROOM sadece ses içindir' : (camOn ? 'Kamerayı Kapat' : 'Kamerayı Aç');
  btnCallCamera.querySelector('.camera-on-icon')?.classList.toggle('hidden', !camOn);
  btnCallCamera.querySelector('.camera-off-icon')?.classList.toggle('hidden', camOn);
}

// ---- Keyboard shortcuts ----

function saveKeyboardShortcuts() {
  localStorage.setItem('anucvc_shortcuts', JSON.stringify(keyboardShortcuts));
}

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight']);

function normalizeShortcutFromEvent(e) {
  // Returns null while only modifier keys are held, so we wait for a real key
  if (MODIFIER_CODES.has(e.code)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('meta');
  parts.push(e.code);
  return parts.join('+');
}

function formatShortcutLabel(combo) {
  if (!combo) return 'Atanmadı';
  return combo.split('+').map(part => {
    if (part === 'ctrl') return 'Ctrl';
    if (part === 'alt') return 'Alt';
    if (part === 'shift') return 'Shift';
    if (part === 'meta') return 'Meta';
    if (part.startsWith('Key')) return part.slice(3);
    if (part.startsWith('Digit')) return part.slice(5);
    if (part === 'Space') return 'Boşluk';
    return part.replace(/^Arrow/, '');
  }).join(' + ');
}

function startRecordingShortcut(btn, action) {
  if (isRecordingShortcut) return;
  isRecordingShortcut = true;
  const originalText = btn.textContent;
  btn.textContent = 'Bir tuşa bas...';
  btn.classList.add('recording');

  const finish = () => {
    isRecordingShortcut = false;
    btn.classList.remove('recording');
    document.removeEventListener('keydown', onKeyDown, true);
  };

  const onKeyDown = (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.code === 'Escape') {
      btn.textContent = originalText;
      finish();
      return;
    }

    const combo = normalizeShortcutFromEvent(e);
    if (!combo) return; // still only modifiers held, keep waiting

    // Prevent assigning the same combo to two different actions
    const conflictAction = Object.keys(keyboardShortcuts).find(a => a !== action && keyboardShortcuts[a] === combo);
    if (conflictAction) {
      delete keyboardShortcuts[conflictAction];
      const conflictBtn = document.getElementById(`shortcut-btn-${conflictAction}`);
      if (conflictBtn) conflictBtn.textContent = 'Atanmadı';
    }

    keyboardShortcuts[action] = combo;
    saveKeyboardShortcuts();
    btn.textContent = formatShortcutLabel(combo);
    finish();
  };

  document.addEventListener('keydown', onKeyDown, true);
}

function triggerShortcutAction(action) {
  if (!voiceManager || !currentVoiceRoom) return;

  if (action === 'toggleMic') {
    const isMuted = voiceManager.toggleMute();
    syncMicDeafenButtonsUI(isMuted, voiceManager.isDeafened);
    updateVoiceGrid();
  } else if (action === 'toggleDeafen') {
    const isDeafened = voiceManager.toggleDeafen();
    syncMicDeafenButtonsUI(voiceManager.isMuted, isDeafened);
    updateVoiceGrid();
  } else if (action === 'toggleCamera') {
    if (voiceManager.isCameraOn) {
      voiceManager.stopCamera();
      updateCameraButtonUI();
      updateVoiceGrid();
    } else {
      voiceManager.startCamera().then(started => {
        if (started) {
          updateCameraButtonUI();
          updateVoiceGrid();
        }
      });
    }
  } else if (action === 'stopScreenShare') {
    // By design, only stopping is supported via shortcut (never starting),
    // since starting requires an explicit picker/consent gesture anyway.
    if (voiceManager.isScreenSharing) {
      voiceManager.stopScreenShare();
      forgetStream(LOCAL_STREAM_OWNER);
      updateScreenShareButtonUI();
      updateVoiceGrid();
    }
  }
}

document.addEventListener('keydown', (e) => {
  if (isRecordingShortcut) return;
  if (!Object.keys(keyboardShortcuts).length) return;

  const active = document.activeElement;
  const isTyping = !!(active && (
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.isContentEditable
  ));
  if (isTyping) return;

  const combo = normalizeShortcutFromEvent(e);
  if (!combo) return;

  const matchedAction = Object.keys(keyboardShortcuts).find(action => keyboardShortcuts[action] === combo);
  if (matchedAction) {
    e.preventDefault();
    if (matchedAction === 'pushToTalk') {
      // Repeats while the key is held (browser auto-repeat) - setPushToTalkActive
      // already no-ops past the first call, so this is harmless.
      if (voiceManager) voiceManager.setPushToTalkActive(true);
    } else {
      triggerShortcutAction(matchedAction);
    }
  }
});

document.addEventListener('keyup', (e) => {
  if (!keyboardShortcuts.pushToTalk || !voiceManager) return;
  const combo = normalizeShortcutFromEvent(e);
  if (combo === keyboardShortcuts.pushToTalk) {
    voiceManager.setPushToTalkActive(false);
  }
});

// Safety net for the "released the key while the window wasn't focused"
// case (e.g. alt-tabbing into a game while holding push-to-talk) - keyup
// never fires here since this document isn't what received it, which would
// otherwise leave the mic stuck open until the next keydown anywhere.
window.addEventListener('blur', () => {
  if (voiceManager && voiceManager.pttMode) voiceManager.setPushToTalkActive(false);
});

// ===== Screen shares ("yayin") =============================================
// A screen share is its own tile in the call grid, next to - not instead of -
// the sharer's camera/avatar tile, so someone who turns on both shows up as
// two separate bubbles.
//
// Watching is opt-in and purely local: an incoming share arrives paused and
// silent and only starts rendering once this viewer clicks it, and the X on
// the tile stops the video and its audio for this viewer alone. Nothing about
// this touches the sender or forces a renegotiation, so re-watching is
// instant (see setScreenAudioAllowed() in webrtc.js).

const LOCAL_STREAM_OWNER = 'local';
const watchedStreams = new Set();
const lastNonZeroStreamVolume = {};

const STREAM_ICON_SPEAKER_ON = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
const STREAM_ICON_SPEAKER_OFF = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none"><line x1="1" y1="1" x2="23" y2="23"/><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M23 9l-6 6"/><path d="M17 9l6 6"/></svg>';
const STREAM_ICON_POPOUT = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="8" height="6" rx="1"/></svg>';
const STREAM_ICON_FS_ENTER = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
const STREAM_ICON_FS_EXIT = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>';
const STREAM_ICON_CLOSE = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const STREAM_ICON_BACK_TO_TAB = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 12h7"/><path d="M12 9l3 3-3 3"/></svg>';
const STREAM_ICON_MONITOR = '<svg viewBox="0 0 24 24" width="26" height="26" stroke="currentColor" stroke-width="1.6" fill="none"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';

// "Servan" -> "Servan'in Yayini". Turkish genitive is four-way vowel-harmonic
// and takes an extra buffer -n after a vowel, so a hardcoded suffix would read
// wrong for most names. Falls back to a neutral label when the name has no
// vowel to harmonise with (numbers, symbols, initials).
function turkishPossessive(name) {
  const clean = String(name || '').trim();
  if (!clean) return '';
  const lower = clean.toLocaleLowerCase('tr');
  let lastVowel = '';
  let lastChar = '';
  for (let i = lower.length - 1; i >= 0; i--) {
    const ch = lower[i];
    if (!lastChar && /[a-z\u00e7\u011f\u0131\u00f6\u015f\u00fc]/.test(ch)) lastChar = ch;
    if ('ae\u0131io\u00f6u\u00fc'.includes(ch)) { lastVowel = ch; break; }
  }
  if (!lastVowel) return '';
  const suffix = 'a\u0131'.includes(lastVowel) ? '\u0131n'
    : 'ei'.includes(lastVowel) ? 'in'
    : 'ou'.includes(lastVowel) ? 'un'
    : '\u00fcn';
  const endsWithVowel = 'ae\u0131io\u00f6u\u00fc'.includes(lastChar);
  return `${clean}'${endsWithVowel ? 'n' : ''}${suffix}`;
}

function getStreamOwnerName(ownerId) {
  if (String(ownerId) === LOCAL_STREAM_OWNER) return getSimpleDisplayName(username) || 'Sen';
  const peer = voiceManager ? voiceManager.peers.get(String(ownerId)) : null;
  return getSimpleDisplayName(peer ? peer.username : '') || 'Kullan\u0131c\u0131';
}

function streamDisplayTitle(ownerId) {
  if (String(ownerId) === LOCAL_STREAM_OWNER) return 'Senin Yay\u0131n\u0131n';
  const owner = getStreamOwnerName(ownerId);
  const possessive = turkishPossessive(owner);
  return possessive ? `${possessive} Yay\u0131n\u0131` : `${owner} \u2014 Yay\u0131n`;
}

function getStreamForOwner(ownerId) {
  if (!voiceManager) return null;
  if (String(ownerId) === LOCAL_STREAM_OWNER) {
    return voiceManager.isScreenSharing ? voiceManager.screenStream : null;
  }
  const peer = voiceManager.peers.get(String(ownerId));
  return peer ? peer.screenStream : null;
}

function getStreamTileEl(ownerId) {
  if (!callViewGrid) return null;
  return callViewGrid.querySelector(`.call-tile-stream[data-stream-owner="${CSS.escape(String(ownerId))}"]`);
}

function isWatchingStream(ownerId) {
  return watchedStreams.has(String(ownerId));
}

function startWatchingStream(ownerId) {
  const id = String(ownerId);
  if (!getStreamForOwner(id)) return;
  watchedStreams.add(id);
  if (id !== LOCAL_STREAM_OWNER && voiceManager) voiceManager.setScreenAudioAllowed(id, true);
  syncStreamTile(id);
}

function stopWatchingStream(ownerId) {
  const id = String(ownerId);
  watchedStreams.delete(id);
  if (id !== LOCAL_STREAM_OWNER && voiceManager) voiceManager.setScreenAudioAllowed(id, false);
  if (streamPopup.ownerId === id) closeStreamPopup();
  const tile = getStreamTileEl(id);
  if (tile && document.fullscreenElement === tile) document.exitFullscreen().catch(() => {});
  syncStreamTile(id);
}

function toggleWatchingStream(ownerId) {
  if (isWatchingStream(ownerId)) stopWatchingStream(ownerId);
  else startWatchingStream(ownerId);
}

// The share itself ended (sharer stopped, or left the room): drop every trace
// of it so a later share from the same person starts un-watched again.
function forgetStream(ownerId) {
  const id = String(ownerId);
  if (streamPopup.ownerId === id) closeStreamPopup();
  watchedStreams.delete(id);
  if (id !== LOCAL_STREAM_OWNER && voiceManager) voiceManager.setScreenAudioAllowed(id, false);
}

function forgetAllStreams() {
  closeStreamPopup();
  for (const id of [...watchedStreams]) forgetStream(id);
  watchedStreams.clear();
}

// Applies watch / pop-out state to an existing tile instead of rebuilding it -
// rebuilding would detach the live MediaStream and restart the decoder.
function syncStreamTile(ownerId) {
  const id = String(ownerId);
  const tile = getStreamTileEl(id);
  if (!tile) return;

  const watching = isWatchingStream(id);
  const poppedOut = streamPopup.ownerId === id;
  const stream = getStreamForOwner(id);
  const video = tile.querySelector('video');

  tile.classList.toggle('is-watching', watching);
  tile.classList.toggle('is-popped-out', poppedOut);

  if (video) {
    if (watching && stream) {
      if (video.srcObject !== stream) video.srcObject = stream;
      // While the stream plays in the pop-out window there is no reason to
      // decode the same frames a second time behind it.
      if (poppedOut || !callViewOpen || document.visibilityState === 'hidden') video.pause();
      else video.play().catch(() => {});
    } else {
      video.pause();
      video.srcObject = null;
    }
  }

  syncStreamVolumeUI(id);
}

function syncAllStreamTiles() {
  callViewGrid?.querySelectorAll('.call-tile-stream').forEach(tile => {
    syncStreamTile(tile.dataset.streamOwner);
  });
}

function getStreamVolume(ownerId) {
  if (String(ownerId) === LOCAL_STREAM_OWNER || !voiceManager) return 1;
  return voiceManager.getPeerScreenVolume(String(ownerId));
}

function setStreamVolume(ownerId, volume) {
  const id = String(ownerId);
  if (id === LOCAL_STREAM_OWNER || !voiceManager) return;
  voiceManager.setPeerScreenVolume(id, volume);
  syncStreamVolumeUI(id);
  if (targetStreamOwnerId === id) syncCtxVolumeUI(getStreamVolume(id));
}

function toggleStreamMute(ownerId) {
  const id = String(ownerId);
  const current = getStreamVolume(id);
  if (current > 0) {
    lastNonZeroStreamVolume[id] = current;
    setStreamVolume(id, 0);
  } else {
    setStreamVolume(id, lastNonZeroStreamVolume[id] || 1);
  }
}

// Keeps every surface showing this stream's level (tile bar + pop-out header)
// in step, whichever one the change came from.
function syncStreamVolumeUI(ownerId) {
  const id = String(ownerId);
  const vol = getStreamVolume(id);
  const scopes = [];
  const tile = getStreamTileEl(id);
  if (tile) scopes.push(tile);
  if (streamPopup.ownerId === id && streamPopup.root) scopes.push(streamPopup.root);

  scopes.forEach(scope => {
    const slider = scope.querySelector('.stream-volume-slider');
    if (slider && slider.ownerDocument.activeElement !== slider) slider.value = String(vol);
    const btn = scope.querySelector('.stream-volume-btn');
    if (btn) {
      btn.innerHTML = vol === 0 ? STREAM_ICON_SPEAKER_OFF : STREAM_ICON_SPEAKER_ON;
      btn.classList.toggle('is-muted', vol === 0);
      btn.title = vol === 0 ? 'Yay\u0131n sesini a\u00e7' : `Yay\u0131n sesi: ${Math.round(vol * 100)}%`;
    }
  });
}

function buildStreamVolumeHtml() {
  return `
    <div class="stream-volume">
      <button type="button" class="stream-tile-btn stream-volume-btn" data-stream-act="mute" title="Yay\u0131n Sesi">${STREAM_ICON_SPEAKER_ON}</button>
      <input type="range" class="stream-volume-slider" min="0" max="1" step="0.01" value="1" title="Yay\u0131n Sesi" />
    </div>
  `;
}

function buildStreamTileHtml(ownerId, title) {
  const isLocal = String(ownerId) === LOCAL_STREAM_OWNER;
  return `
    <video autoplay playsinline muted></video>
    <div class="stream-tile-idle">
      <span class="stream-tile-idle-icon">${STREAM_ICON_MONITOR}</span>
      <span class="stream-tile-idle-title">Yay\u0131n a\u00e7\u0131k</span>
      <span class="stream-tile-idle-hint">\u0130zlemek i\u00e7in t\u0131kla</span>
    </div>
    <div class="stream-tile-popped">
      <span class="stream-tile-popped-text">K\u00fc\u00e7\u00fck pencerede oynat\u0131l\u0131yor</span>
      <button type="button" class="stream-tile-inline-btn" data-stream-act="return">Buraya geri al</button>
    </div>
    <span class="voice-screenshare-live-badge">CANLI</span>
    <div class="stream-tile-actions">
      ${isLocal ? '' : buildStreamVolumeHtml()}
      <button type="button" class="stream-tile-btn" data-stream-act="popup" title="K\u00fc\u00e7\u00fck Pencere">${STREAM_ICON_POPOUT}</button>
      <button type="button" class="stream-tile-btn stream-fs-btn" data-stream-act="fullscreen" title="Tam Ekran">${STREAM_ICON_FS_ENTER}</button>
      <button type="button" class="stream-tile-btn danger" data-stream-act="stop" title="\u0130zlemeyi B\u0131rak">${STREAM_ICON_CLOSE}</button>
    </div>
    <div class="call-tile-footer">
      <span class="call-tile-name">${escapeHtml(title)}</span>
    </div>
  `;
}

// One delegated handler per tile covers every control on it, so the tile can be
// patched in place without any listener bookkeeping.
function wireStreamTile(tile, ownerId) {
  const id = String(ownerId);

  tile.addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-stream-act]');
    if (actionBtn) {
      e.stopPropagation();
      const act = actionBtn.dataset.streamAct;
      if (act === 'stop') stopWatchingStream(id);
      else if (act === 'popup') openStreamPopup(id);
      else if (act === 'fullscreen') toggleStreamFullscreen(id);
      else if (act === 'mute') toggleStreamMute(id);
      else if (act === 'return') closeStreamPopup();
      return;
    }
    if (e.target.closest('.stream-volume-slider')) return;
    if (!isWatchingStream(id)) startWatchingStream(id);
  });

  tile.addEventListener('dblclick', (e) => {
    if (e.target.closest('[data-stream-act], .stream-volume-slider')) return;
    if (isWatchingStream(id)) toggleStreamFullscreen(id);
  });

  tile.querySelector('.stream-volume-slider')?.addEventListener('input', (e) => {
    e.stopPropagation();
    setStreamVolume(id, parseFloat(e.target.value));
  });

  tile.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openStreamContextMenu(id, e.clientX, e.clientY);
  });
}

// Fullscreen targets the tile, not the <video>. Fullscreening a video element
// is what made the browser paint its own media controls over the stream - a
// pause button and a volume slider that moved the (always-muted) video's own
// level and therefore did nothing, since stream audio plays through a separate
// <audio> element. A plain element gets no such controls.
function toggleStreamFullscreen(ownerId) {
  const tile = getStreamTileEl(ownerId);
  if (!tile) return;
  if (document.fullscreenElement === tile) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  if (!isWatchingStream(ownerId)) startWatchingStream(ownerId);
  if (streamPopup.ownerId === String(ownerId)) closeStreamPopup();
  tile.requestFullscreen?.().catch(err => console.error('Fullscreen request failed:', err));
}

document.addEventListener('fullscreenchange', () => {
  const fsEl = document.fullscreenElement;
  callViewGrid?.querySelectorAll('.call-tile-stream').forEach(tile => {
    const isFs = tile === fsEl;
    tile.classList.toggle('is-fullscreen', isFs);
    const btn = tile.querySelector('.stream-fs-btn');
    if (btn) {
      btn.innerHTML = isFs ? STREAM_ICON_FS_EXIT : STREAM_ICON_FS_ENTER;
      btn.title = isFs ? 'Tam Ekrandan \u00c7\u0131k' : 'Tam Ekran';
    }
  });
});

// --- Pop-out window --------------------------------------------------------
// Document Picture-in-Picture gives a real, freely resizable OS window that
// floats above other applications - the Opera-style video popout. It is not
// available everywhere (older WebView2 builds behind the Tauri shell, Firefox),
// so the fallback is an in-app floating panel with the same controls, its own
// drag handle and a resize grip.

const STREAM_POPUP_SIZE_KEY = 'anucvc_stream_popup_size';
const streamPopup = { ownerId: null, mode: null, win: null, root: null, video: null };

function readStreamPopupSize() {
  try {
    const raw = JSON.parse(localStorage.getItem(STREAM_POPUP_SIZE_KEY) || 'null');
    if (raw && raw.w > 0 && raw.h > 0) {
      return { w: Math.min(1280, Math.max(280, raw.w)), h: Math.min(800, Math.max(180, raw.h)) };
    }
  } catch (e) {}
  return { w: 480, h: 300 };
}

function saveStreamPopupSize(w, h) {
  try { localStorage.setItem(STREAM_POPUP_SIZE_KEY, JSON.stringify({ w: Math.round(w), h: Math.round(h) })); } catch (e) {}
}

function buildStreamPopupRoot(ownerId) {
  const isLocal = String(ownerId) === LOCAL_STREAM_OWNER;
  const root = document.createElement('div');
  root.className = 'stream-popup';
  root.innerHTML = `
    <div class="stream-popup-header">
      <span class="stream-popup-title">${escapeHtml(streamDisplayTitle(ownerId))}</span>
      <div class="stream-popup-controls">
        ${isLocal ? '' : buildStreamVolumeHtml()}
        <button type="button" class="stream-tile-btn" data-popup-act="back" title="Sekmeye D\u00f6n">${STREAM_ICON_BACK_TO_TAB}</button>
        <button type="button" class="stream-tile-btn danger" data-popup-act="close" title="\u0130zlemeyi B\u0131rak">${STREAM_ICON_CLOSE}</button>
      </div>
    </div>
    <div class="stream-popup-body"><video autoplay playsinline muted></video></div>
    <div class="stream-popup-resize" title="Boyutland\u0131r"></div>
  `;

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-popup-act], [data-stream-act]');
    if (!btn) return;
    const act = btn.dataset.popupAct || btn.dataset.streamAct;
    if (act === 'back') { const id = streamPopup.ownerId; closeStreamPopup(); focusAppWindow(id); }
    else if (act === 'close') closeStreamPopup({ stopWatching: true });
    else if (act === 'mute') toggleStreamMute(streamPopup.ownerId);
  });

  root.querySelector('.stream-volume-slider')?.addEventListener('input', (e) => {
    setStreamVolume(streamPopup.ownerId, parseFloat(e.target.value));
  });

  return root;
}

function copyStylesIntoPipWindow(win) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules).map(rule => rule.cssText).join('');
      const style = win.document.createElement('style');
      style.textContent = css;
      win.document.head.appendChild(style);
    } catch (e) {
      if (!sheet.href) continue;
      const link = win.document.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      win.document.head.appendChild(link);
    }
  }
}

async function openStreamPopup(ownerId) {
  const id = String(ownerId);
  const stream = getStreamForOwner(id);
  if (!stream) return;

  if (streamPopup.ownerId === id) { focusStreamPopup(); return; }
  if (streamPopup.ownerId) closeStreamPopup();

  if (!isWatchingStream(id)) startWatchingStream(id);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});

  const root = buildStreamPopupRoot(id);
  const video = root.querySelector('video');
  video.srcObject = stream;

  streamPopup.ownerId = id;
  streamPopup.root = root;
  streamPopup.video = video;

  const size = readStreamPopupSize();
  let opened = false;

  if (window.documentPictureInPicture && typeof window.documentPictureInPicture.requestWindow === 'function') {
    try {
      const pipWin = await window.documentPictureInPicture.requestWindow({ width: size.w, height: size.h });
      copyStylesIntoPipWindow(pipWin);
      pipWin.document.body.classList.add('stream-popup-window');
      root.classList.add('is-pip');
      pipWin.document.body.appendChild(root);
      // The OS window frame is the resize handle here, so just remember its size.
      pipWin.addEventListener('resize', () => saveStreamPopupSize(pipWin.innerWidth, pipWin.innerHeight));
      // Closing through the window's own control means "back to the app", not
      // "stop watching" - that is what the X inside the popup is for.
      pipWin.addEventListener('pagehide', () => { if (streamPopup.win === pipWin) closeStreamPopup(); });
      streamPopup.win = pipWin;
      streamPopup.mode = 'pip';
      opened = true;
    } catch (err) {
      console.log('Document Picture-in-Picture unavailable, using in-app popup:', err);
    }
  }

  if (!opened) {
    root.classList.add('is-floating');
    root.style.width = `${size.w}px`;
    root.style.height = `${size.h}px`;
    root.style.left = `${Math.max(12, window.innerWidth - size.w - 24)}px`;
    root.style.top = `${Math.max(12, window.innerHeight - size.h - 24)}px`;
    document.body.appendChild(root);
    makeStreamPopupDraggable(root);
    makeStreamPopupResizable(root);
    streamPopup.mode = 'floating';
  }

  video.play().catch(() => {});
  syncStreamTile(id);
}

function focusStreamPopup() {
  if (streamPopup.mode === 'pip' && streamPopup.win) {
    try { streamPopup.win.focus(); } catch (e) {}
  }
}

function closeStreamPopup(opts = {}) {
  const id = streamPopup.ownerId;
  if (!id) return;

  const { root, video, win, mode } = streamPopup;
  streamPopup.ownerId = null;
  streamPopup.root = null;
  streamPopup.video = null;
  streamPopup.win = null;
  streamPopup.mode = null;

  if (video) { try { video.pause(); } catch (e) {} video.srcObject = null; }
  if (mode === 'floating' && root) {
    saveStreamPopupSize(root.offsetWidth, root.offsetHeight);
    root.remove();
  }
  if (mode === 'pip' && win) {
    try { root?.remove(); } catch (e) {}
    try { win.close(); } catch (e) {}
  }

  if (opts.stopWatching) stopWatchingStream(id);
  else syncStreamTile(id);
}

// "Back to tab": bring AnucVC forward and put the stream back in its tile.
function focusAppWindow(streamOwnerId) {
  if (currentVoiceRoom) openCallView();
  if (streamOwnerId) syncStreamTile(streamOwnerId);
  try { window.focus(); } catch (e) {}
  if (!isRunningInTauri) return;
  (async () => {
    try {
      const { appWindow } = await import('@tauri-apps/api/window');
      // Separate try blocks: these are two distinct allowlist entries, and a
      // denied one must not stop the other from running.
      try { await appWindow.unminimize(); } catch (e) {}
      try { await appWindow.setFocus(); } catch (e) {}
    } catch (e) {}
  })();
}

function makeStreamPopupDraggable(root) {
  const handle = root.querySelector('.stream-popup-header');
  if (!handle) return;
  let startX = 0, startY = 0, originX = 0, originY = 0, dragging = false;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input')) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    const rect = root.getBoundingClientRect();
    originX = rect.left; originY = rect.top;
    handle.setPointerCapture(e.pointerId);
    root.classList.add('is-dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const maxX = Math.max(0, window.innerWidth - root.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - root.offsetHeight);
    root.style.left = `${Math.min(maxX, Math.max(0, originX + e.clientX - startX))}px`;
    root.style.top = `${Math.min(maxY, Math.max(0, originY + e.clientY - startY))}px`;
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
    root.classList.remove('is-dragging');
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
}

function makeStreamPopupResizable(root) {
  const grip = root.querySelector('.stream-popup-resize');
  if (!grip) return;
  let startX = 0, startY = 0, startW = 0, startH = 0, resizing = false;

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    resizing = true;
    startX = e.clientX; startY = e.clientY;
    startW = root.offsetWidth; startH = root.offsetHeight;
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const rect = root.getBoundingClientRect();
    const maxW = Math.max(280, window.innerWidth - rect.left - 8);
    const maxH = Math.max(180, window.innerHeight - rect.top - 8);
    root.style.width = `${Math.min(maxW, Math.max(280, startW + e.clientX - startX))}px`;
    root.style.height = `${Math.min(maxH, Math.max(180, startH + e.clientY - startY))}px`;
  });
  const endResize = (e) => {
    if (!resizing) return;
    resizing = false;
    try { grip.releasePointerCapture(e.pointerId); } catch (err) {}
    saveStreamPopupSize(root.offsetWidth, root.offsetHeight);
  };
  grip.addEventListener('pointerup', endResize);
  grip.addEventListener('pointercancel', endResize);
}

// Quality options come from the shared preset table so the menu and the
// getDisplayMedia constraints can never drift apart.
function renderScreenQualityMenu() {
  const list = document.getElementById('screenshare-quality-list');
  if (!list) return;
  const current = localStorage.getItem('anucvc_screen_quality') || '720p_30';
  list.innerHTML = Object.entries(SCREEN_QUALITY_PRESETS).map(([key, preset]) => `
    <button type="button" class="screenshare-menu-item${key === current ? ' is-active' : ''}" data-quality="${key}">
      <span class="ss-fps-chip">${preset.fps}<small>fps</small></span>
      <span class="ss-item-text">
        <span class="ss-item-title">${preset.label}</span>
        <span class="ss-item-note">${escapeHtml(preset.note)}</span>
      </span>
      <span class="ss-item-check"><svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="3" fill="none"><polyline points="20 6 9 17 4 12"/></svg></span>
    </button>
  `).join('');
}



function showChangePwError(msg) {
  changePwError.textContent = msg;
  changePwError.classList.remove('hidden');
}

// --- CIRCULAR AVATAR CROPPER LOGIC ---
function openAvatarCropper(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      cropImageObj = img;
      cropZoom = 1;
      cropZoomRange.value = 1;
      cropOffsetX = 0;
      cropOffsetY = 0;
      avatarCropModal.classList.remove('hidden');
      drawCropCanvas();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function drawCropCanvas() {
  if (!cropImageObj) return;
  const ctx = cropCanvas.getContext('2d');
  ctx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);

  const cw = cropCanvas.width;
  const ch = cropCanvas.height;

  const aspect = cropImageObj.width / cropImageObj.height;
  let baseW, baseH;
  if (aspect >= 1) {
    baseH = ch;
    baseW = ch * aspect;
  } else {
    baseW = cw;
    baseH = cw / aspect;
  }

  // effectiveZoom never drops below 1: baseW/baseH already "cover" the whole
  // square canvas at zoom 1, so anything smaller would leave empty corners
  // outside the photo showing through, same fix as the banner cropper below.
  const effectiveZoom = Math.max(1, cropZoom);
  const drawW = baseW * effectiveZoom;
  const drawH = baseH * effectiveZoom;

  // Strict offset clamping: never let the image be dragged far enough to
  // expose empty canvas background (the circular crop area must always be
  // fully covered by the photo).
  const maxOffsetX = (drawW - cw) / 2;
  const maxOffsetY = (drawH - ch) / 2;
  cropOffsetX = Math.max(-maxOffsetX, Math.min(maxOffsetX, cropOffsetX));
  cropOffsetY = Math.max(-maxOffsetY, Math.min(maxOffsetY, cropOffsetY));

  const drawX = (cw - drawW) / 2 + cropOffsetX;
  const drawY = (ch - drawH) / 2 + cropOffsetY;

  ctx.drawImage(cropImageObj, drawX, drawY, drawW, drawH);
}

function applyAvatarCrop() {
  if (!cropImageObj) return;

  const offscreen = document.createElement('canvas');
  offscreen.width = 128;
  offscreen.height = 128;
  const ctx = offscreen.getContext('2d');

  ctx.beginPath();
  ctx.arc(64, 64, 64, 0, Math.PI * 2, true);
  ctx.closePath();
  ctx.clip();

  const scaleRatio = 128 / 260;

  const cw = cropCanvas.width;
  const ch = cropCanvas.height;
  const aspect = cropImageObj.width / cropImageObj.height;
  let baseW, baseH;
  if (aspect >= 1) {
    baseH = ch;
    baseW = ch * aspect;
  } else {
    baseW = cw;
    baseH = cw / aspect;
  }

  const effectiveZoom = Math.max(1, cropZoom);
  const drawW = baseW * effectiveZoom * scaleRatio;
  const drawH = baseH * effectiveZoom * scaleRatio;

  const maxOffsetX = (baseW * effectiveZoom - cw) / 2;
  const maxOffsetY = (baseH * effectiveZoom - ch) / 2;
  cropOffsetX = Math.max(-maxOffsetX, Math.min(maxOffsetX, cropOffsetX));
  cropOffsetY = Math.max(-maxOffsetY, Math.min(maxOffsetY, cropOffsetY));

  const drawX = (128 - drawW) / 2 + cropOffsetX * scaleRatio;
  const drawY = (128 - drawH) / 2 + cropOffsetY * scaleRatio;

  ctx.drawImage(cropImageObj, drawX, drawY, drawW, drawH);

  pendingAvatarDataUrl = offscreen.toDataURL('image/webp', 0.85);
  settingsAvatarImg.src = pendingAvatarDataUrl;
  settingsAvatarImg.classList.remove('hidden');
  settingsAvatarInitial.classList.add('hidden');

  avatarCropModal.classList.add('hidden');
}

// --- RECTANGULAR BANNER CROPPER LOGIC ---
function openBannerCropper(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      bannerCropImageObj = img;
      bannerCropZoom = 1;
      if (bannerCropZoomRange) bannerCropZoomRange.value = 1;
      bannerCropOffsetX = 0;
      bannerCropOffsetY = 0;
      if (bannerCropModal) bannerCropModal.classList.remove('hidden');
      drawBannerCropCanvas();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function drawBannerCropCanvas() {
  if (!bannerCropImageObj || !bannerCropCanvas) return;
  const ctx = bannerCropCanvas.getContext('2d');
  ctx.clearRect(0, 0, bannerCropCanvas.width, bannerCropCanvas.height);

  const cw = bannerCropCanvas.width;
  const ch = bannerCropCanvas.height;

  const aspect = bannerCropImageObj.width / bannerCropImageObj.height;
  const canvasAspect = cw / ch;

  let baseW, baseH;
  if (aspect >= canvasAspect) {
    baseH = ch;
    baseW = ch * aspect;
  } else {
    baseW = cw;
    baseH = cw / aspect;
  }

  const effectiveZoom = Math.max(1, bannerCropZoom);
  const drawW = baseW * effectiveZoom;
  const drawH = baseH * effectiveZoom;

  // Strict offset clamping: prevent any empty side, top or bottom gaps
  const maxOffsetX = (drawW - cw) / 2;
  const maxOffsetY = (drawH - ch) / 2;
  bannerCropOffsetX = Math.max(-maxOffsetX, Math.min(maxOffsetX, bannerCropOffsetX));
  bannerCropOffsetY = Math.max(-maxOffsetY, Math.min(maxOffsetY, bannerCropOffsetY));

  const drawX = (cw - drawW) / 2 + bannerCropOffsetX;
  const drawY = (ch - drawH) / 2 + bannerCropOffsetY;

  ctx.drawImage(bannerCropImageObj, drawX, drawY, drawW, drawH);
}

function applyBannerCrop() {
  if (!bannerCropImageObj || !bannerCropCanvas) return;

  const outW = 650;
  const outH = 200;
  const offscreen = document.createElement('canvas');
  offscreen.width = outW;
  offscreen.height = outH;
  const ctx = offscreen.getContext('2d');

  const scaleRatio = outW / bannerCropCanvas.width;

  const cw = bannerCropCanvas.width;
  const ch = bannerCropCanvas.height;
  const aspect = bannerCropImageObj.width / bannerCropImageObj.height;
  const canvasAspect = cw / ch;

  let baseW, baseH;
  if (aspect >= canvasAspect) {
    baseH = ch;
    baseW = ch * aspect;
  } else {
    baseW = cw;
    baseH = cw / aspect;
  }

  const effectiveZoom = Math.max(1, bannerCropZoom);
  const drawW = baseW * effectiveZoom * scaleRatio;
  const drawH = baseH * effectiveZoom * scaleRatio;

  const maxOffsetX = (baseW * effectiveZoom - cw) / 2;
  const maxOffsetY = (baseH * effectiveZoom - ch) / 2;
  bannerCropOffsetX = Math.max(-maxOffsetX, Math.min(maxOffsetX, bannerCropOffsetX));
  bannerCropOffsetY = Math.max(-maxOffsetY, Math.min(maxOffsetY, bannerCropOffsetY));

  const drawX = (outW - drawW) / 2 + bannerCropOffsetX * scaleRatio;
  const drawY = (outH - drawH) / 2 + bannerCropOffsetY * scaleRatio;

  ctx.drawImage(bannerCropImageObj, drawX, drawY, drawW, drawH);

  pendingBannerDataUrl = offscreen.toDataURL('image/webp', 0.85);
  if (settingsBannerImg) {
    settingsBannerImg.style.backgroundImage = `url(${pendingBannerDataUrl})`;
  }
  if (bannerCropModal) bannerCropModal.classList.add('hidden');
}

function compressAndResizeImage(file, maxWidth = 800, maxHeight = 800, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > maxWidth || height > maxHeight) {
          if (width > height) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(dataUrl);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function clearSelectedImage() {
  selectedImageData = null;
  if (imageFileInput) imageFileInput.value = '';
  if (imagePreviewThumb) imagePreviewThumb.src = '';
  if (imagePreviewBar) imagePreviewBar.classList.add('hidden');
}

function saveEditMessageAction() {
  const newContent = inputEditMsg.value.trim();
  if (newContent && targetMessageForEdit && socket) {
    socket.emit('edit-message', {
      messageId: targetMessageForEdit.id,
      roomId: currentTextRoom,
      newContent
    });
  }
  editMessageModal.classList.add('hidden');
}

function getFormattedDisplayName(rawUsername) {
  if (!rawUsername) return '';
  const unameLower = rawUsername.toLowerCase();
  const customNick = userNicknames[unameLower];
  if (customNick) {
    return `<span class="italic-nickname" style="font-style:italic;">${escapeHtml(customNick)}</span> <span class="real-name-dim" style="opacity:0.7; font-weight:normal; font-size:0.9em;">(${escapeHtml(rawUsername)})</span>`;
  }
  return escapeHtml(rawUsername);
}

function showUserProfilePopover(userObj, event) {
  if (!userProfilePopover) return;
  
  const targetUsername = typeof userObj === 'string' ? userObj : (userObj.username || '');
  if (!targetUsername) return;

  const cachedUser = allUsersCache.find(u => (u.username || '').toLowerCase() === targetUsername.toLowerCase()) || {};
  const finalAvatar = (typeof userObj === 'object' && userObj.avatar) ? userObj.avatar : (cachedUser.avatar || null);
  const finalBio = (typeof userObj === 'object' && userObj.bio) ? userObj.bio : (cachedUser.bio || '');
  const finalBanner = (typeof userObj === 'object' && userObj.banner) ? userObj.banner : (cachedUser.banner || null);
  const finalId = (typeof userObj === 'object' && userObj.id) ? userObj.id : (cachedUser.id || null);
  const finalStatus = (typeof userObj === 'object' && userObj.status) ? userObj.status : (cachedUser.status || '');

  const popoverBannerElem = userProfilePopover.querySelector('.popover-banner');
  if (popoverBannerElem) {
    if (finalBanner) {
      popoverBannerElem.style.backgroundImage = cssImageUrl(finalBanner);
    } else {
      popoverBannerElem.style.backgroundImage = '';
    }
  }

  popoverUsername.innerHTML = getFormattedDisplayName(targetUsername);
  popoverUsertag.textContent = finalId ? formatUserTag(finalId) : '';

  const popoverStatusElem = document.getElementById('popover-status');
  if (popoverStatusElem) {
    const trimmedStatus = (finalStatus || '').trim();
    popoverStatusElem.textContent = trimmedStatus;
    popoverStatusElem.classList.toggle('hidden', !trimmedStatus);
  }

  const popoverChestnut = document.getElementById('popover-chestnut');
  if (popoverChestnut) {
    popoverChestnut.classList.toggle('hidden', !myFriendsSet.has(targetUsername.toLowerCase()));
  }

  if (finalAvatar) {
    popoverAvatarImg.src = finalAvatar;
    popoverAvatarImg.classList.remove('hidden');
    popoverAvatarInitial.classList.add('hidden');
  } else {
    popoverAvatarImg.classList.add('hidden');
    popoverAvatarInitial.textContent = targetUsername.charAt(0).toUpperCase();
    popoverAvatarInitial.classList.remove('hidden');
  }

  popoverBio.textContent = finalBio.trim() ? finalBio : 'Henüz bir biyografi eklenmemiş.';

  // Measure the popover's real rendered size (bio text length varies, so a
  // hardcoded height estimate would drift and let it overflow the viewport)
  // by laying it out off-screen first, then placing it at the clamped
  // position - all before the browser paints, so there's no visible flash.
  userProfilePopover.style.left = '-9999px';
  userProfilePopover.style.top = '-9999px';
  userProfilePopover.classList.remove('hidden');

  const rect = userProfilePopover.getBoundingClientRect();
  const cardWidth = rect.width || 325;
  const cardHeight = rect.height || 260;

  let x = event.clientX + 10;
  let y = event.clientY + 10;

  if (x + cardWidth > window.innerWidth) {
    x = window.innerWidth - cardWidth - 12;
  }
  if (y + cardHeight > window.innerHeight) {
    y = window.innerHeight - cardHeight - 12;
  }
  if (x < 12) x = 12;
  if (y < 12) y = 12;

  userProfilePopover.style.left = `${x}px`;
  userProfilePopover.style.top = `${y}px`;
  userProfilePopover.classList.remove('hidden');
}

function openUserContextMenu(socketId, peerUsername, mouseX, mouseY, isInVoice = false) {
  contextMenu.classList.add('hidden');
  if (userProfilePopover) userProfilePopover.classList.add('hidden');

  // Friend requests / DMs / nicknames don't make sense on the AI bot.
  if (isAiBot(peerUsername)) return;

  targetUserSocketIdForVol = socketId;
  targetUserForAction = { username: peerUsername, socketId };
  ctxVolumeMode = 'mic';
  targetStreamOwnerId = null;
  userCtxStreamToggle?.classList.add('hidden');
  if (userCtxVolLabel) userCtxVolLabel.textContent = 'Ses Seviyesi';

  userCtxName.innerHTML = getFormattedDisplayName(peerUsername || 'Kullanıcı');

  const peerLower = (peerUsername || '').toLowerCase();
  const isSelf = peerLower === (username || '').toLowerCase();
  const isFriend = myFriendsSet.has(peerLower);

  const incomingReqs = friendRequests.incoming || [];
  const outgoingReqs = friendRequests.outgoing || [];
  const isPending = incomingReqs.some(r => (r.sender_username || '').toLowerCase() === peerLower) ||
                    outgoingReqs.some(r => (r.receiver_username || '').toLowerCase() === peerLower);

  // Self vs Other options in context menu
  const userCtxEditProfile = document.getElementById('user-ctx-edit-profile');
  if (userCtxEditProfile) userCtxEditProfile.classList.toggle('hidden', !isSelf);
  if (userCtxMuteNotif) userCtxMuteNotif.classList.toggle('hidden', isSelf);
  if (userCtxSetNickname) userCtxSetNickname.classList.toggle('hidden', isSelf);

  const userCtxAddFriend = document.getElementById('user-ctx-add-friend');
  const userCtxPendingFriend = document.getElementById('user-ctx-pending-friend');
  const userCtxSendDm = document.getElementById('user-ctx-send-dm');
  const userCtxRemoveFriend = document.getElementById('user-ctx-remove-friend');

  if (userCtxAddFriend) userCtxAddFriend.classList.toggle('hidden', isSelf || isFriend || isPending);
  if (userCtxPendingFriend) userCtxPendingFriend.classList.toggle('hidden', isSelf || isFriend || !isPending);
  if (userCtxSendDm) userCtxSendDm.classList.toggle('hidden', isSelf || !isFriend);
  if (userCtxRemoveFriend) userCtxRemoveFriend.classList.toggle('hidden', isSelf || !isFriend);

  const isAdmin = currentUser && currentUser.role === 'admin';
  const userCtxAdminDeleteUser = document.getElementById('user-ctx-admin-delete-user');
  if (userCtxAdminDeleteUser) {
    userCtxAdminDeleteUser.classList.toggle('hidden', !isAdmin || isSelf);
  }

  // Hide volume slider if not in voice chat or if target user is oneself
  const userCtxVol = document.querySelector('.user-ctx-vol');
  if (userCtxVol) {
    userCtxVol.classList.toggle('hidden', !isInVoice || isSelf);
  }

  const isMutedNotif = !!mutedUsers[(peerUsername || '').toLowerCase()];
  if (userCtxMuteNotifText) {
    userCtxMuteNotifText.textContent = isMutedNotif ? 'Sessizliği Kaldır' : 'Kullanıcıyı Sessize Al';
  }

  if (isInVoice && !isSelf) {
    const peer = voiceManager ? voiceManager.peers.get(socketId) : null;
    syncCtxVolumeUI(peer ? peer.volume : 1.0);
  }

  // Show user context menu and apply viewport boundary checks
  userContextMenu.classList.remove('hidden');
  placeUserContextMenu(mouseX, mouseY);
}

// Right-clicking a stream bubble adjusts that share's own audio (independent of
// the sharer's microphone level) and can stop/resume watching it.
function openStreamContextMenu(ownerId, mouseX, mouseY) {
  const id = String(ownerId);
  contextMenu.classList.add('hidden');
  if (userProfilePopover) userProfilePopover.classList.add('hidden');

  ctxVolumeMode = 'screen';
  targetStreamOwnerId = id;
  targetUserSocketIdForVol = null;
  targetUserForAction = null;

  userCtxName.textContent = streamDisplayTitle(id);

  [
    'user-ctx-edit-profile', 'user-ctx-mute-notifications', 'user-ctx-set-nickname',
    'user-ctx-add-friend', 'user-ctx-pending-friend', 'user-ctx-send-dm',
    'user-ctx-remove-friend', 'user-ctx-admin-delete-user'
  ].forEach(elemId => document.getElementById(elemId)?.classList.add('hidden'));

  const isLocal = id === LOCAL_STREAM_OWNER;
  // Your own share has no incoming audio to turn down.
  document.querySelector('.user-ctx-vol')?.classList.toggle('hidden', isLocal);
  if (userCtxVolLabel) userCtxVolLabel.textContent = 'Yayın Sesi';
  if (!isLocal) syncCtxVolumeUI(getStreamVolume(id));

  userCtxStreamToggle?.classList.remove('hidden');
  if (userCtxStreamToggleText) {
    userCtxStreamToggleText.textContent = isWatchingStream(id) ? 'Yayını İzlemeyi Bırak' : 'Yayını İzle';
  }

  userContextMenu.classList.remove('hidden');
  placeUserContextMenu(mouseX, mouseY);
}

function placeUserContextMenu(mouseX, mouseY) {

  const menuW = userContextMenu.offsetWidth || 180;
  const menuH = userContextMenu.offsetHeight || 160;
  let x = mouseX;
  let y = mouseY;

  if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 12;
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 12;
  if (x < 12) x = 12;
  if (y < 12) y = 12;

  userContextMenu.style.left = `${x}px`;
  userContextMenu.style.top = `${y}px`;
}

// Paints the shared slider/percentage/speaker-icon trio, whichever level the
// menu is currently bound to.
function syncCtxVolumeUI(vol) {
  if (!userCtxVolTxt || !userCtxVolSlider || !userCtxSpeakerBtn) return;
  const percent = Math.round(vol * 100);

  userCtxVolTxt.textContent = `${percent}%`;
  userCtxVolTxt.classList.toggle('is-muted', percent === 0);
  if (document.activeElement !== userCtxVolSlider) userCtxVolSlider.value = String(vol);

  userCtxSpeakerBtn.querySelector('.vol-on-icon')?.classList.toggle('hidden', percent === 0);
  userCtxSpeakerBtn.querySelector('.vol-off-icon')?.classList.toggle('hidden', percent !== 0);
  userCtxSpeakerBtn.classList.toggle('is-muted', percent === 0);
}

function updateUserVolumeUI(socketId, vol) {
  if (voiceManager) {
    voiceManager.setPeerVolume(socketId, vol);
  }

  if (ctxVolumeMode === 'mic' && targetUserSocketIdForVol === socketId) syncCtxVolumeUI(vol);

  updateVoiceGrid();
  scheduleChannelListRender();
}

// --- AUTHENTICATION LOGIC ---
function setupAuthEventListeners() {
  tabLogin.addEventListener('click', () => setAuthTab('login'));
  tabRegister.addEventListener('click', () => setAuthTab('register'));

  btnAuthSubmit.addEventListener('click', handleAuthSubmit);
  authPasswordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAuthSubmit();
  });
}

function setAuthTab(mode) {
  authMode = mode;
  tabLogin.classList.toggle('active', mode === 'login');
  tabRegister.classList.toggle('active', mode === 'register');

  const lblAuthEmail = document.getElementById('lbl-auth-email');

  if (mode === 'register') {
    groupUsername.style.display = 'flex';
    if (lblAuthEmail) lblAuthEmail.textContent = 'E-Posta Adresi';
    authEmailInput.placeholder = 'anuc@attiwan.com';
    btnAuthSubmit.textContent = 'Kayıt Ol';
  } else {
    groupUsername.style.display = 'none';
    if (lblAuthEmail) lblAuthEmail.textContent = 'E-Posta veya Kullanıcı Adı';
    authEmailInput.placeholder = 'anuc@attiwan.com veya Anuc';
    btnAuthSubmit.textContent = 'Giriş Yap';
  }
  hideAuthError();
}

function showAuthScreen() {
  authOverlay.classList.remove('hidden');
  setAuthTab('login');
}

function showAuthError(msg) {
  authErrorBadge.textContent = msg;
  authErrorBadge.classList.remove('hidden');
}

function hideAuthError() {
  authErrorBadge.textContent = '';
  authErrorBadge.classList.add('hidden');
}

async function handleAuthSubmit() {
  hideAuthError();

  const inputVal = authEmailInput.value.trim();
  const password = authPasswordInput.value;
  const uname = authUsernameInput.value.trim();

  if (authMode === 'register') {
    if (!inputVal || !EMAIL_REGEX.test(inputVal)) {
      showAuthError('Lütfen geçerli bir e-posta adresi giriniz.');
      return;
    }
    if (!uname) {
      showAuthError('Lütfen kullanıcı adınızı giriniz.');
      return;
    }
  } else {
    if (!inputVal) {
      showAuthError('Lütfen e-posta adresinizi veya kullanıcı adınızı giriniz.');
      return;
    }
  }

  if (!password || password.length < 6) {
    showAuthError('Şifre en az 6 karakter olmalıdır.');
    return;
  }

  const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
  const payload = authMode === 'register' 
    ? { email: inputVal, password, username: uname } 
    : { identifier: inputVal, password };

  btnAuthSubmit.disabled = true;
  btnAuthSubmit.textContent = 'Lütfen bekleyin...';

  try {
    const res = await fetch(`${serverUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      showAuthError(data.error || 'İşlem başarısız oldu.');
      return;
    }

    authToken = data.token;
    currentUser = data.user;
    username = data.user.username;
    userAvatar = data.user.avatar || null;

    localStorage.setItem('anucvc_token', authToken);
    localStorage.setItem('anucvc_user', JSON.stringify(currentUser));
    localStorage.setItem('anucvc_username', username);
    if (authMode === 'register') {
      // Consumed once the socket connects for the first time - see the
      // 'claim-welcome-dm' emit in connectSocket()'s 'connect' handler.
      localStorage.setItem('anucvc_await_welcome_dm', '1');
    }

    authOverlay.classList.add('hidden');
    updateUserDisplay();
    connectSocket();

  } catch (err) {
    console.error('Auth request error:', err);
    // If the auth overlay is already hidden, login itself succeeded and
    // something failed afterward (e.g. while setting up the app) — showing
    // the error inside the now-hidden auth overlay would be invisible, so
    // surface it visibly instead.
    if (authOverlay.classList.contains('hidden')) {
      reportFatalClientError(err && err.message ? err.message : String(err));
    } else {
      showAuthError('Sunucuya bağlanılamadı. Lütfen sunucunun açık olduğundan emin olun.');
    }
  } finally {
    btnAuthSubmit.disabled = false;
    btnAuthSubmit.textContent = authMode === 'login' ? 'Giriş Yap' : 'Kayıt Ol';
  }
}

async function verifySession() {
  if (!authToken) return false;
  try {
    const res = await fetch(`${serverUrl}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const data = await res.json();
    if (res.ok && data.success) {
      currentUser = data.user;
      username = data.user.username;
      userAvatar = data.user.avatar || null;
      localStorage.setItem('anucvc_user', JSON.stringify(currentUser));
      return true;
    }
  } catch (e) {
    console.error('Session verify error:', e);
  }
  return false;
}

function performLogout() {
  disconnectVoice();
  if (socket) socket.disconnect();

  authToken = null;
  currentUser = null;
  userAvatar = null;
  localStorage.removeItem('anucvc_token');
  localStorage.removeItem('anucvc_user');
  // Otherwise a registration interrupted before the socket connects (tab
  // closed right after signup) leaves this flag pending, and a DIFFERENT
  // account logging in later on the same/shared browser would incorrectly
  // replay AnucAI's welcome DM as a fresh notification for that account.
  localStorage.removeItem('anucvc_await_welcome_dm');

  showAuthScreen();
}

function openCreateChannelModal(type) {
  channelModalMode = 'create';
  channelModalType = type;
  channelModalTitle.textContent = type === 'voice' ? 'Yeni Ses Odası Oluştur' : 'Yeni Metin Kanalı Oluştur';
  inputChannelName.value = '';
  channelModal.classList.remove('hidden');
  inputChannelName.focus();
}

function openRenameChannelModal(room) {
  channelModalMode = 'rename';
  targetChannelForAction = room;
  channelModalTitle.textContent = 'Kanal Adını Değiştir';
  inputChannelName.value = room.name || '';
  channelModal.classList.remove('hidden');
  inputChannelName.focus();
}

function saveChannelModalAction() {
  const channelName = inputChannelName.value.trim();
  if (!channelName) return;

  if (channelModalMode === 'create') {
    if (socket) {
      socket.emit('create-channel', { name: channelName, type: channelModalType });
    }
  } else if (channelModalMode === 'rename') {
    const roomId = targetChannelForAction ? targetChannelForAction.id : currentTextRoom;
    if (socket) {
      socket.emit('rename-channel', { roomId, newName: channelName });
    }
  }

  channelModal.classList.add('hidden');
}

function formatUserTag(id) {
  if (id === undefined || id === null) return '';
  return '#' + String(id).padStart(4, '0');
}

function isAdminUser() {
  return !!(currentUser && currentUser.role === 'admin');
}

// Creating channels is admin-only on the server, so the "+" buttons are
// only shown to admins.
function applyAdminChannelControls() {
  const isAdmin = isAdminUser();
  if (btnAddTextChannel) btnAddTextChannel.classList.toggle('hidden', !isAdmin);
  if (btnAddVoiceChannel) btnAddVoiceChannel.classList.toggle('hidden', !isAdmin);
}

function updateUserDisplay() {
  applyAdminChannelControls();
  displayNameElem.textContent = username;
  if (userTag) {
    userTag.textContent = currentUser && currentUser.id ? formatUserTag(currentUser.id) : '';
  }
  if (userAvatar) {
    userAvatarImg.src = userAvatar;
    userAvatarImg.classList.remove('hidden');
    userAvatarInitial.classList.add('hidden');
  } else {
    userAvatarImg.classList.add('hidden');
    userAvatarInitial.textContent = username.charAt(0).toUpperCase();
    userAvatarInitial.classList.remove('hidden');
  }
}

function setConnectionStatus(visible, message) {
  if (!connectionStatusBanner) return;
  if (message && connectionStatusText) {
    connectionStatusText.textContent = message;
  }
  connectionStatusBanner.classList.toggle('hidden', !visible);
}

async function fetchRooms() {
  try {
    const res = await fetch(`${serverUrl}/api/rooms`, {
      headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
    });
    const data = await res.json();
    const roomsList = Array.isArray(data) ? data : (data.rooms || []);
    lastFetchedRooms = roomsList;
    renderChannelList(roomsList);
    setConnectionStatus(false);
    return roomsList;
  } catch (err) {
    console.error('Fetch rooms error:', err);
    setConnectionStatus(true, 'Sunucuya bağlanılamıyor, tekrar deneniyor...');
  }
  return [];
}

async function fetchAllUsers() {
  if (!authToken) return [];
  try {
    const res = await fetch(`${serverUrl}/api/users`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const data = await res.json();
    if (res.ok && data.success && Array.isArray(data.users)) {
      allUsersCache = data.users;
      mentionRenderRegexCache = null;
      return data.users;
    }
  } catch (err) {
    console.error('Fetch all users error:', err);
  }
  return [];
}

function connectSocket() {
  if (socket) {
    socket.disconnect();
  }

  socket = io(serverUrl, {
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    // The server takes this socket's identity from the signed session token
    // only. A function so every reconnect sends the current token (it
    // changes after a password change).
    auth: (cb) => cb({ token: authToken })
  });

  // Pull the ICE server list (STUN, plus a TURN relay if the server has one
  // configured) before anyone can join a voice room. Deliberately not awaited:
  // it only matters by the time a room is clicked, and blocking startup on it
  // would delay the whole app if the request is slow.
  loadIceServers(serverUrl);

  voiceManager = new VoiceManager(socket, {
    onPeerJoined: scheduleVoiceGridRender,
    onPeerLeft: (socketId) => {
      forgetStream(socketId);
      scheduleVoiceGridRender();
    },
    onStatusChange: (data) => {
      if (data && data.socketId) {
        if (data.isTalking !== undefined) {
          setTalkingStatus(data.socketId, data.isTalking);
        }
        if (data.isMuted !== undefined || data.isDeafened !== undefined || data.isScreenSharing !== undefined || data.isCameraOn !== undefined) {
          if (data.isScreenSharing === false) forgetStream(data.socketId);
          scheduleVoiceGridRender();
          scheduleChannelListRender();
        }
      } else {
        scheduleVoiceGridRender();
      }
    },
    onScreenShareTrack: (socketId, stream) => {
      if (!stream) forgetStream(socketId);
      scheduleVoiceGridRender();
    },
    onLocalScreenShareEnded: () => {
      forgetStream(LOCAL_STREAM_OWNER);
      updateScreenShareButtonUI();
      scheduleVoiceGridRender();
    },
    onCameraTrack: (socketId, stream) => {
      scheduleVoiceGridRender();
    },
    onLocalCameraEnded: () => {
      updateCameraButtonUI();
      scheduleVoiceGridRender();
    }
  });

  socket.on('connect', () => {
    console.log('Connected to server via Socket.IO');
    setConnectionStatus(false);
    socket.emit('set-username', { token: authToken });
    // A reconnect (e.g. a network blip while backgrounded) lands on a fresh
    // server-side entry that defaults to away:false - reassert it if the tab
    // was already marked away before the drop.
    if (isMarkedAway) socket.emit('set-away', true);
    if (localStorage.getItem('anucvc_await_welcome_dm') === '1') {
      localStorage.removeItem('anucvc_await_welcome_dm');
      socket.emit('claim-welcome-dm');
    }

    fetchAllUsers();
    socket.emit('get-friends-data');

    fetchRooms().then(() => {
      joinTextRoom(currentTextRoom);
    });
  });

  socket.on('voice-occupants-updated', (occupantsData) => {
    voiceOccupantsMap = occupantsData || {};
    scheduleChannelListRender();
    // Sync talking state across all occupants in sidebar and grid, after the
    // sidebar rows for this update actually exist.
    requestAnimationFrame(() => {
      for (const occupants of Object.values(voiceOccupantsMap)) {
        for (const occ of occupants) setTalkingStatus(occ.socketId, occ.isTalking);
      }
    });

    // Join/leave sounds: this occupancy broadcast is transport-agnostic (it
    // covers full-mesh P2P rooms and the server-relayed CS2 ROOM the exact
    // same way), so diffing it against the last known occupants of whatever
    // room the local user is actually connected to works for both without
    // caring which kind of room it is. Only ever compares within the room
    // we're in - other rooms' occupancy changing in the sidebar shouldn't
    // make noise. The local user's own arrival/departure is silent, same as
    // Discord: you hear others join/leave, not yourself.
    if (currentVoiceRoom) {
      const currentOccupantIds = new Set((voiceOccupantsMap[currentVoiceRoom] || []).map(o => o.socketId));
      if (lastKnownVoiceOccupantRoom === currentVoiceRoom) {
        const isDeafened = !!(voiceManager && voiceManager.isDeafened);
        if (!isDeafened) {
          for (const id of currentOccupantIds) {
            if (id !== socket.id && !lastKnownVoiceOccupantIds.has(id)) playVoiceJoinSound();
          }
          for (const id of lastKnownVoiceOccupantIds) {
            if (id !== socket.id && !currentOccupantIds.has(id)) playVoiceLeaveSound();
          }
        }
      }
      lastKnownVoiceOccupantIds = currentOccupantIds;
      lastKnownVoiceOccupantRoom = currentVoiceRoom;
    } else {
      lastKnownVoiceOccupantIds = new Set();
      lastKnownVoiceOccupantRoom = null;
    }
  });

  socket.on('channel-created', (newRoom) => {
    fetchRooms().then(() => {
      if (newRoom.type === 'text') {
        joinTextRoom(newRoom.id, newRoom.name);
      }
    });
  });

  socket.on('channel-renamed', (updatedRoom) => {
    fetchRooms().then(() => {
      if (updatedRoom.id === currentTextRoom) {
        currentChannelNameElem.textContent = updatedRoom.name;
        chatInput.placeholder = `#${updatedRoom.name} kanalına mesaj gönder...`;
      }
      if (updatedRoom.id === currentVoiceRoom) {
        voiceRoomNameElem.textContent = updatedRoom.name;
        if (callViewRoomTitle) callViewRoomTitle.textContent = updatedRoom.name;
      }
    });
  });

  socket.on('channel-deleted', ({ roomId }) => {
    fetchRooms().then(() => {
      if (roomId === currentTextRoom) {
        const textRooms = (lastFetchedRooms || []).filter(r => r.type === 'text');
        if (textRooms.length > 0) {
          joinTextRoom(textRooms[0].id, textRooms[0].name);
        }
      }
    });
    if (roomId === currentVoiceRoom) {
      disconnectVoice();
    }
  });

  socket.on('message-history', ({ roomId, messages, dmReadState: incomingDmReadState }) => {
    const historyRoomId = String(roomId || '');
    const currentRoomId = String(currentTextRoom || '');

    messageCache[historyRoomId] = messages || [];
    saveMessageCacheToStorage();

    if (incomingDmReadState) {
      dmReadState[historyRoomId] = incomingDmReadState;
    }

    if (historyRoomId === currentRoomId) {
      if (!messages || messages.length === 0) {
        if (messagesContainer) {
          clearRenderedMessages();
          messagesContainer.insertAdjacentHTML('afterbegin', `
            <div class="chat-empty-placeholder">
              <span class="chat-placeholder-emoji">💬</span>
              <span>Henüz bu kanalda mesaj yok. İlk mesajı sen gönder!</span>
            </div>
          `);
        }
      } else {
        renderMessages(messages); // already scrolls to bottom
      }

      // Opening a DM marks its newest message read for me - the OTHER
      // participant's sent-message ticks flip to "read" once this comes
      // back around as a dm-read-updated broadcast.
      if (historyRoomId.startsWith('dm_') && messages && messages.length > 0 && socket) {
        const latestId = messages[messages.length - 1].id;
        socket.emit('mark-dm-read', { roomId: historyRoomId, messageId: latestId });
      }
    }
  });

  socket.on('message-edited', ({ id, roomId, content }) => {
    const msgRoomId = String(roomId || '');
    const currentRoomId = String(currentTextRoom || '');

    if (messageCache[msgRoomId]) {
      const cachedMsg = messageCache[msgRoomId].find(m => String(m.id) === String(id));
      if (cachedMsg) {
        cachedMsg.content = content;
        saveMessageCacheToStorage();
      }
    }

    if (msgRoomId === currentRoomId) {
      const msgTextElem = document.querySelector(`.message-item[data-msg-id="${id}"] .msg-text`);
      if (msgTextElem) {
        msgTextElem.innerHTML = renderMessageContent(content);
      }

      // Also update any reply-quote previews that reference this message
      document.querySelectorAll(`.msg-reply-quote[data-target-msg-id="${id}"] .reply-quote-text`).forEach(quoteTextElem => {
        quoteTextElem.textContent = content;
      });
      stickToBottomIfPinned();
    }
  });

  socket.on('dm-read-updated', ({ roomId, userId: readerUserId, lastReadMessageId }) => {
    if (!roomId) return;
    if (!dmReadState[roomId]) dmReadState[roomId] = {};
    const prev = dmReadState[roomId][readerUserId] || 0;
    if (lastReadMessageId <= prev) return;
    dmReadState[roomId][readerUserId] = lastReadMessageId;

    // Only the other participant's read cursor moving affects MY sent
    // messages' ticks - my own cursor updating (from marking their messages
    // read) has nothing to redraw.
    const myId = currentUser && currentUser.id != null ? String(currentUser.id) : null;
    if (!myId || String(readerUserId) === myId) return;

    if (String(roomId) === String(currentTextRoom)) {
      updateDmTicksInView(roomId);
    }
  });

  socket.on('reaction-updated', ({ messageId, roomId, emoji, username: reactorUsername, action }) => {
    const msgRoomId = String(roomId || '');
    const currentRoomId = String(currentTextRoom || '');

    const cachedMsg = messageCache[msgRoomId]?.find(m => String(m.id) === String(messageId));
    if (!cachedMsg) return;

    if (!cachedMsg.reactions) cachedMsg.reactions = {};
    if (action === 'add') {
      if (!cachedMsg.reactions[emoji]) cachedMsg.reactions[emoji] = [];
      if (!cachedMsg.reactions[emoji].includes(reactorUsername)) cachedMsg.reactions[emoji].push(reactorUsername);
    } else if (cachedMsg.reactions[emoji]) {
      cachedMsg.reactions[emoji] = cachedMsg.reactions[emoji].filter(u => u !== reactorUsername);
      if (cachedMsg.reactions[emoji].length === 0) delete cachedMsg.reactions[emoji];
    }
    saveMessageCacheToStorage();

    if (msgRoomId === currentRoomId) {
      const msgItem = document.querySelector(`.message-item[data-msg-id="${messageId}"]`);
      const reactionsElem = msgItem?.querySelector('.msg-reactions');
      if (reactionsElem) {
        reactionsElem.outerHTML = renderReactionsBarHtml(cachedMsg);
      }
      stickToBottomIfPinned();
    }
  });

  socket.on('message-deleted', ({ id, roomId }) => {
    const msgRoomId = String(roomId || '');
    const currentRoomId = String(currentTextRoom || '');

    if (messageCache[msgRoomId]) {
      messageCache[msgRoomId] = messageCache[msgRoomId].filter(m => String(m.id) !== String(id));
      saveMessageCacheToStorage();
    }

    if (msgRoomId === currentRoomId) {
      removeRenderedMessage(document.querySelector(`.message-item[data-msg-id="${id}"]`));
      applyMessageGrouping();
    }
    // Update any reply quotes referencing this deleted message in the active chat view
    document.querySelectorAll(`.msg-reply-quote[data-target-msg-id="${id}"]`).forEach(quoteElem => {
      quoteElem.classList.add('quote-deleted');
      const textSpan = quoteElem.querySelector('.reply-quote-text');
      if (textSpan) {
        textSpan.innerHTML = '<i>Bu mesaj silindi</i>';
      }
    });
  });

  socket.on('channels-reordered', (rooms) => {
    lastFetchedRooms = rooms;
    renderChannelList(rooms);
  });

  socket.on('user-profile-updated', ({ userId: targetUserId, username: targetUser, avatar: targetAvatar, bio: targetBio, banner: targetBanner, status: targetStatus }) => {
    // Username changes must be matched by the stable userId, not the (now stale)
    // cached username - otherwise the rename is missed entirely and the old name
    // lingers in allUsersCache as a phantom "offline" duplicate of the same user.
    const cachedUser = targetUserId != null
      ? allUsersCache.find(u => String(u.id) === String(targetUserId))
      : allUsersCache.find(u => (u.username || '').toLowerCase() === (targetUser || '').toLowerCase());
    if (cachedUser) {
      if (targetUser) cachedUser.username = targetUser;
      if (targetAvatar !== undefined) cachedUser.avatar = targetAvatar;
      if (targetBio !== undefined) cachedUser.bio = targetBio;
      if (targetBanner !== undefined) cachedUser.banner = targetBanner;
      if (targetStatus !== undefined) cachedUser.status = targetStatus;
      mentionRenderRegexCache = null;
    }
    // The member list shows the custom status under each name, so a profile
    // edit has to repaint it - the presence payload itself never changed.
    if (lastOnlineData) scheduleOnlineUsersRender(lastOnlineData);
    refreshRenderedAuthor(targetUser, targetAvatar);
  });

  socket.on('connect_error', (err) => {
    console.error('Socket connection error:', err);
    setConnectionStatus(true, 'Sunucuya bağlanılamıyor, tekrar deneniyor...');
  });

  socket.on('disconnect', (reason) => {
    console.log('Socket disconnected:', reason);
    setConnectionStatus(true, 'Bağlantı koptu, yeniden bağlanılıyor...');
  });

  // Typing indicator. One shared expiry timer for everyone, rather than a
  // fresh setTimeout per received keystroke event.
  socket.on('user-typing', ({ username: typer, roomId }) => {
    const typerRoomId = String(roomId || '');
    const currentRoomId = String(currentTextRoom || '');
    if (typerRoomId !== currentRoomId && currentRoomId) return;
    if (typer && typer.toLowerCase() === (username || '').toLowerCase()) return;
    typingUsers[typer] = Date.now();
    updateTypingIndicator();
    startTypingExpiryTimer();
  });

  socket.on('user-stop-typing', ({ username: typer }) => {
    if (typer && typingUsers[typer]) {
      delete typingUsers[typer];
      updateTypingIndicator();
    }
  });

  // Online users
  socket.on('online-users-updated', (users) => {
    scheduleOnlineUsersRender(users);
  });

  socket.on('older-messages-history', ({ roomId, beforeId, messages: olderMsgs }) => {
    isLoadingOlderMessages = false;
    if (String(roomId) !== String(currentTextRoom)) return;
    if (!olderMsgs || olderMsgs.length === 0) {
      reachedOldestMessage.add(String(roomId));
      return;
    }

    if (!messageCache[roomId]) messageCache[roomId] = [];
    const existingIds = new Set(messageCache[roomId].map(m => String(m.id)));
    const newOlder = olderMsgs.filter(m => !existingIds.has(String(m.id)));
    if (newOlder.length > 0) {
      messageCache[roomId] = [...newOlder, ...messageCache[roomId]];
      saveMessageCacheToStorage();
    }

    // Decide what to render by what is on screen, not by what the cache has
    // seen: rows trimmed off the top earlier are still cached, and filtering
    // them out here meant scrolling back up could never bring them back.
    const firstRendered = messagesContainer?.querySelector('.message-item[data-msg-id]');
    const firstRenderedId = firstRendered ? Number(firstRendered.dataset.msgId) : Infinity;
    const toRender = olderMsgs.filter(m => Number(m.id) < firstRenderedId);
    if (messagesContainer && toRender.length > 0) {
      prependOlderMessages(toRender);
    }
  });

  // Unread badges + notification sound + cache update
  socket.on('new-message', (msg) => {
    if (!msg) return;
    const author = msg.username || msg.senderName;
    if (author && typingUsers[author]) {
      delete typingUsers[author];
      updateTypingIndicator();
    }
    const msgRoomId = String(msg.room_id || msg.roomId || '');
    const currentRoomId = String(currentTextRoom || '');

    // Cache update for target room
    if (!messageCache[msgRoomId]) {
      messageCache[msgRoomId] = [];
    }
    if (!messageCache[msgRoomId].some(m => String(m.id) === String(msg.id))) {
      messageCache[msgRoomId].push(msg);
      if (messageCache[msgRoomId].length > 100) {
        messageCache[msgRoomId].shift();
      }
      saveMessageCacheToStorage();
    }

    if (msgRoomId === currentRoomId) {
      appendMessage(msg); // already scrolls to bottom
      if (callViewOpen) {
        incrementCallViewUnread();
      }
      // Already looking at this DM when the message lands - mark it read
      // immediately rather than waiting for the next time the room is opened.
      if (msgRoomId.startsWith('dm_') && author !== username && socket) {
        socket.emit('mark-dm-read', { roomId: msgRoomId, messageId: msg.id });
      }
    } else {
      // new-message is a global broadcast (every online socket gets every
      // DM, not just its participants - see architecture notes), so without
      // this check any user would get an unread badge/toast/OS notification
      // showing the content of OTHER people's private DMs.
      if (msgRoomId.startsWith('dm_')) {
        const dmParticipantIds = msgRoomId.slice(3).split('_');
        const myId = currentUser && currentUser.id != null ? String(currentUser.id) : null;
        if (!myId || !dmParticipantIds.includes(myId)) return;
      }

      const isMutedChannel = !!mutedChannels[msg.room_id];
      const isMutedUser = !!mutedUsers[(author || '').toLowerCase()];

      const contentStr = (msg.content || '').toLowerCase();
      const myName = (username || '').toLowerCase();
      const isMentionForMe = myName && (contentStr.includes(`@${myName}`) || contentStr.includes('@all') || contentStr.includes('@everyone'));

      // If user is muted, only play sound/unread IF it is an explicit mention for me
      if (!isMutedChannel && (!isMutedUser || isMentionForMe)) {
        unreadCounts[msg.room_id] = (unreadCounts[msg.room_id] || 0) + 1;
        saveUnreadStateToStorage();
        scheduleChannelListRender();
        if (msgRoomId.startsWith('dm_')) updateFriendsTabBadge();
        playAppNotificationSound(0.25);
        if (callViewOpen) {
          incrementCallViewUnread();
        }

        // Direct messages don't show up in the regular channel list, so
        // they need their own clearly-visible notification (a text-channel
        // unread badge alone would go unnoticed there).
        if (msgRoomId.startsWith('dm_')) {
          showToast(`${getFormattedDisplayName(author)}: ${msg.content ? msg.content.trim().substring(0, 80) : '[Görsel]'}`, 'info');
          sendDesktopNotification(
            `${author} size mesaj gönderdi`,
            msg.content ? msg.content.trim().substring(0, 120) : '[Görsel]'
          );
          // Taskbar/favicon badge tracks anything that just triggered a
          // desktop notification, not only @mentions - otherwise a DM could
          // pop an OS notification with no badge to match it.
          totalUnreadMentions++;
          updateAppBadgeCount(totalUnreadMentions);
          if (currentMainView === 'friends') {
            renderFriendsDMList();
          }
        }
      }
    }
  });

  socket.on('user-deleted-by-admin', ({ username: deletedUsername }) => {
    if (!deletedUsername) return;

    // Remove deleted user's messages from DOM
    if (messagesContainer) {
      // This used to look for an `.author-name` element that has never existed
      // in the markup, so a deleted user's messages just stayed on screen
      // until the next reload. data-author carries the real username even when
      // a local nickname has replaced the rendered text.
      const authorKey = CSS.escape(deletedUsername.toLowerCase());
      messagesContainer.querySelectorAll(`.msg-item[data-author="${authorKey}"]`)
        .forEach(removeRenderedMessage);
      applyMessageGrouping();
    }

    // Remove deleted user's messages from messageCache
    if (messageCache) {
      Object.keys(messageCache).forEach(roomId => {
        if (messageCache[roomId]) {
          messageCache[roomId] = messageCache[roomId].filter(
            msg => (msg.username || msg.senderName || '').toLowerCase() !== deletedUsername.toLowerCase()
          );
        }
      });
      saveMessageCacheToStorage();
    }

    // Sadece admin olmayan kullanıcılara göster, admin zaten ne yaptığını biliyor
    const isAdmin = currentUser && currentUser.role === 'admin';
    if (!isAdmin) {
      showAccountDeletedModal(`"${deletedUsername}" adlı kullanıcı ve tüm verileri veritabanından silindi.`);
    }
    
    // Online listeyi güncelle
    if (lastOnlineData) {
      const updatedOnlineData = Array.isArray(lastOnlineData) 
        ? lastOnlineData.filter(u => (u.username || '').toLowerCase() !== deletedUsername.toLowerCase())
        : { ...lastOnlineData, onlineUsers: (lastOnlineData.onlineUsers || []).filter(u => (u.username || '').toLowerCase() !== deletedUsername.toLowerCase()) };
      renderOnlineUsers(updatedOnlineData);
    }
  });

  // The server no longer recognizes this session (expired, password changed
  // elsewhere, or a token from before tokens were signed) - send the user
  // back to the login screen instead of leaving a half-working app open.
  socket.on('session-invalid', () => {
    performLogout();
  });

  socket.on('account-deleted', ({ message }) => {
    const deletedModal = document.getElementById('account-deleted-modal');
    const deletedMsg = document.getElementById('account-deleted-message');
    const btnAck = document.getElementById('btn-ack-account-deleted');

    const msg = message || 'Hesabınız ve tüm verileriniz yönetici tarafından veritabanından kalıcı olarak silinmiştir.';
    if (deletedMsg) deletedMsg.textContent = msg;

    if (btnAck) {
      btnAck.onclick = () => {
        localStorage.clear();
        sessionStorage.clear();
        location.reload();
      };
    }

    if (deletedModal) {
      deletedModal.classList.remove('hidden');
    } else {
      localStorage.clear();
      sessionStorage.clear();
      location.reload();
    }
  });

  // --- FRIEND SYSTEM SOCKET LISTENERS ---
  socket.on('friends-data-response', ({ friends, requests }) => {
    updateFriendsData(friends, requests);
  });

  socket.on('error', (data) => {
    if (!data || !data.message) return;
    showToast(data.message, 'error');
    // This channel carries every server-side rejection, not just friend
    // requests - writing all of them into the Add Friend status line meant an
    // unrelated failure (a rename refused, a message that couldn't be edited)
    // would surface there the next time that tab was opened. Only mirror it
    // there while the user is actually looking at it.
    const addStatus = document.getElementById('dash-add-friend-status');
    const addPane = document.getElementById('friends-pane-add');
    if (addStatus && addPane && addPane.classList.contains('active') && currentMainView === 'friends') {
      addStatus.textContent = data.message;
      addStatus.className = 'add-friend-status error';
      addStatus.classList.remove('hidden');
    }
  });

  socket.on('friend-request-sent', ({ message }) => {
    showToast(message || 'Arkadaşlık isteği gönderildi.', 'success');
    const addStatus = document.getElementById('dash-add-friend-status');
    if (addStatus) {
      addStatus.textContent = message || 'Arkadaşlık isteği gönderildi.';
      addStatus.className = 'add-friend-status success';
      addStatus.classList.remove('hidden');
    }
    if (socket) socket.emit('get-friends-data');
  });

  socket.on('friend-request-received', ({ senderUsername }) => {
    showToast(`"${senderUsername}" size arkadaşlık isteği gönderildi!`, 'info');
    playAppNotificationSound(0.3);
    if (socket) socket.emit('get-friends-data');
  });

  socket.on('friend-request-accepted', () => {
    showToast('Arkadaşlık isteği kabul edildi!', 'success');
    if (socket) socket.emit('get-friends-data');
  });

  socket.on('dm-room-ready', ({ room }) => {
    if (room && room.id) {
      // Opening a DM always shows the chat pane (regardless of whether it was
      // triggered from the friends dashboard, the sidebar, or a right-click
      // "Mesaj Gönder"), but keeps the sidebar on the recent-DMs list rather
      // than swapping in the server's text/voice channel groups.
      switchMainView('server', 'dms');
      joinTextRoom(room.id, room.name);
    }
  });

  socket.on('dm-room-created', () => {
    if (socket) socket.emit('get-friends-data');
  });

  // Mention notifications: play a sound, raise taskbar badge & desktop notification
  socket.on('mention-notify', (data) => {
    const isMuted = !!mutedChannels[data.roomId];
    if (!isMuted && data.roomId !== currentTextRoom) {
      unreadCounts[data.roomId] = (unreadCounts[data.roomId] || 0) + 1;
    }
    totalUnreadMentions++;
    saveUnreadStateToStorage();
    updateAppBadgeCount(totalUnreadMentions);
    scheduleChannelListRender();

    playAppNotificationSound(0.35);

    sendDesktopNotification(
      `${data.author} sizden bahsetti`,
      `#${data.roomName}: ${data.content}`
    );
  });
}


let notificationAudioBuffer = null;
let audioCtxForNotif = null;

// The same clip used to ship as a ~16KB base64 data URL inlined right here in
// the bundle, which every user downloaded and every browser had to parse as
// JavaScript before the app could start - for a file that already sits in
// client/public and is already referenced by the <audio id="notification-sound">
// fallback element. Fetched like the join/leave clips below instead; if it
// fails, playAppNotificationSound() still falls back to that <audio> element.
async function loadNotificationAudioBuffer() {
  try {
    if (!audioCtxForNotif) {
      audioCtxForNotif = new (window.AudioContext || window.webkitAudioContext)();
    }
    const res = await fetch('/notification.mp3');
    const arrayBuffer = await res.arrayBuffer();
    notificationAudioBuffer = await audioCtxForNotif.decodeAudioData(arrayBuffer);
  } catch (e) {
    console.log('Notification AudioBuffer decode fallback:', e);
  }
}

loadNotificationAudioBuffer();

const unlockAudioOnUserGesture = () => {
  if (audioCtxForNotif && audioCtxForNotif.state === 'suspended') {
    audioCtxForNotif.resume().catch(() => {});
  }
  if (!notificationAudioBuffer) {
    loadNotificationAudioBuffer();
  }
};
document.addEventListener('click', unlockAudioOnUserGesture, { once: true });
document.addEventListener('keydown', unlockAudioOnUserGesture, { once: true });

// The 0.25/0.35 etc. volumes passed in at each call site are relative
// weights (a mention/DM rings slightly louder than a plain unread), not
// absolute levels - this scales all of them by the user's notification
// volume preference (0-100 slider, see settings wiring below) without
// needing to touch every call site.
function getNotifVolumeMultiplier() {
  const raw = localStorage.getItem('anucvc_notif_volume');
  const pct = raw === null ? 70 : parseInt(raw, 10);
  return Math.max(0, Math.min(100, isNaN(pct) ? 70 : pct)) / 100;
}

let lastNotificationPlayTime = 0;
function playAppNotificationSound(volume = 0.35) {
  if (localStorage.getItem('anucvc_notif_sound') === 'false') return;
  volume = volume * getNotifVolumeMultiplier();
  if (volume <= 0) return;
  const now = Date.now();
  if (now - lastNotificationPlayTime < 150) return;
  lastNotificationPlayTime = now;

  if (notificationAudioBuffer) {
    try {
      if (!audioCtxForNotif) {
        audioCtxForNotif = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtxForNotif.state === 'suspended') {
        audioCtxForNotif.resume().catch(() => {});
      }
      const source = audioCtxForNotif.createBufferSource();
      const gainNode = audioCtxForNotif.createGain();
      source.buffer = notificationAudioBuffer;
      gainNode.gain.value = volume;
      source.connect(gainNode);
      gainNode.connect(audioCtxForNotif.destination);
      source.start(0);
      return;
    } catch (e) {
      console.log('Web Audio play failed, falling back to HTML5 audio:', e);
    }
  }

  if (notificationSound) {
    try {
      notificationSound.volume = volume;
      notificationSound.currentTime = 0;
      const p = notificationSound.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {});
      }
    } catch (e) {}
  }
}

// --- Voice channel join/leave sounds ---------------------------------
// Decoded once into AudioBuffers (same approach as the notification sound
// above) so overlapping joins/leaves in a busy call each get their own
// playback instead of cutting each other off the way a single shared
// <audio> element would.
let voiceJoinSoundBuffer = null;
let voiceLeaveSoundBuffer = null;

async function loadVoiceEventSound(url) {
  try {
    if (!audioCtxForNotif) {
      audioCtxForNotif = new (window.AudioContext || window.webkitAudioContext)();
    }
    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    return await audioCtxForNotif.decodeAudioData(arrayBuffer);
  } catch (e) {
    console.log(`Voice event sound load failed (${url}):`, e);
    return null;
  }
}

loadVoiceEventSound('/Mitai.mp3').then(buf => { voiceJoinSoundBuffer = buf; });
loadVoiceEventSound('/Baka.mp3').then(buf => { voiceLeaveSoundBuffer = buf; });

function playVoiceEventBuffer(buffer, volume = 0.4) {
  if (!buffer || !audioCtxForNotif) return;
  try {
    if (audioCtxForNotif.state === 'suspended') {
      audioCtxForNotif.resume().catch(() => {});
    }
    const source = audioCtxForNotif.createBufferSource();
    const gainNode = audioCtxForNotif.createGain();
    source.buffer = buffer;
    gainNode.gain.value = volume;
    source.connect(gainNode);
    gainNode.connect(audioCtxForNotif.destination);
    source.start(0);
  } catch (e) {}
}

function playVoiceJoinSound() { playVoiceEventBuffer(voiceJoinSoundBuffer, 0.4); }
function playVoiceLeaveSound() { playVoiceEventBuffer(voiceLeaveSoundBuffer, 0.4); }

let totalUnreadMentions = 0;
let lastRenderedBadgeCount = -1;

async function updateAppBadgeCount(count) {
  totalUnreadMentions = Math.max(0, count);

  // Skip re-render if badge count hasn't changed
  if (totalUnreadMentions === lastRenderedBadgeCount) return;
  lastRenderedBadgeCount = totalUnreadMentions;

  const baseTitle = 'AnucVC';

  if (totalUnreadMentions > 0) {
    document.title = `(${totalUnreadMentions}) ${baseTitle}`;
  } else {
    document.title = baseTitle;
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    // Draw app brand background logo (Purple rounded rectangle with white 'A')
    ctx.fillStyle = '#5865f2';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(0, 0, 64, 64, 16);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, 64, 64);
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('A', 32, 34);

    if (totalUnreadMentions > 0) {
      // Draw Red Circle Badge in Top-Right corner
      const badgeRadius = 16;
      const badgeX = 64 - badgeRadius - 2;
      const badgeY = badgeRadius + 2;

      ctx.beginPath();
      ctx.arc(badgeX, badgeY, badgeRadius, 0, 2 * Math.PI, false);
      ctx.fillStyle = '#ed4245';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // Draw Badge Count Text inside Red Circle
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const text = totalUnreadMentions > 99 ? '99+' : String(totalUnreadMentions);
      ctx.fillText(text, badgeX, badgeY + 1);
    }

    const dataUrl = canvas.toDataURL('image/png');

    // Dynamic Favicon Update
    let faviconLink = document.querySelector("link[rel*='icon']");
    if (!faviconLink) {
      faviconLink = document.createElement('link');
      faviconLink.rel = 'icon';
      document.head.appendChild(faviconLink);
    }
    faviconLink.href = dataUrl;

    // Tauri: window title (safely, without Windows Taskbar shell flashing)
    // and the actual taskbar/window icon, reusing the exact same badged PNG
    // just drawn for the favicon above.
    if (typeof window !== 'undefined' && window.__TAURI__) {
      const appWindow = window.__TAURI__.window?.appWindow || window.__TAURI__.window?.getCurrent();
      if (appWindow) {
        if (typeof appWindow.setTitle === 'function') {
          try {
            await appWindow.setTitle(totalUnreadMentions > 0 ? `(${totalUnreadMentions}) ${baseTitle}` : baseTitle);
          } catch (e) {}
        }
        if (typeof appWindow.setIcon === 'function') {
          try {
            await appWindow.setIcon(dataUrlToPngBytes(dataUrl));
          } catch (e) {
            console.error('setIcon error:', e);
          }
        }
      }
    }
  } catch (err) {
    console.error('Error generating badged taskbar icon:', err);
  }
}

// appWindow.setIcon() takes raw PNG bytes, not a data: URL string (that
// string form is documented as a file path instead) - decode the canvas's
// base64 payload into a Uint8Array so Tauri's icon-png feature can read it.
function dataUrlToPngBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Reset badge only when window gains focus
window.addEventListener('focus', () => {
  updateAppBadgeCount(0);
});

let activeDragChannelId = null;

function attachChannelDragAndDrop(item, room) {
  // Reordering is admin-only on the server; don't offer a drag that would
  // only snap back.
  if (!isAdminUser()) return;

  // 1. Standard HTML5 Drag & Drop
  item.draggable = true;

  item.addEventListener('dragstart', (e) => {
    activeDragChannelId = room.id;
    item.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', room.id);
    }
  });

  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (activeDragChannelId && activeDragChannelId !== room.id) {
      const sourceRoom = lastFetchedRooms ? lastFetchedRooms.find(r => r.id === activeDragChannelId) : null;
      if (sourceRoom && sourceRoom.type === room.type) {
        item.classList.add('drag-over');
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      }
    }
  });

  item.addEventListener('dragleave', () => {
    item.classList.remove('drag-over');
  });

  item.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    item.classList.remove('drag-over');
    executeChannelSwap(activeDragChannelId, room.id, room.type);
    activeDragChannelId = null;
  });

  item.addEventListener('dragend', () => {
    document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('dragging', 'drag-over'));
    activeDragChannelId = null;
  });

  // 2. Mouse / Pointer Fallback for Tauri WebView2 compatibility
  item.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // Only left-click
    let isMouseDragging = false;
    const startY = e.clientY;

    const onMouseMove = (moveEvt) => {
      if (Math.abs(moveEvt.clientY - startY) > 5) {
        isMouseDragging = true;
        activeDragChannelId = room.id;
        item.classList.add('dragging');

        // Find element under cursor
        const elemUnder = document.elementFromPoint(moveEvt.clientX, moveEvt.clientY);
        const targetChannelItem = elemUnder ? elemUnder.closest('.channel-item') : null;

        document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('drag-over'));
        if (targetChannelItem && targetChannelItem.dataset.id !== room.id) {
          const targetId = targetChannelItem.dataset.id;
          const targetRoom = lastFetchedRooms ? lastFetchedRooms.find(r => r.id === targetId) : null;
          if (targetRoom && targetRoom.type === room.type) {
            targetChannelItem.classList.add('drag-over');
          }
        }
      }
    };

    const onMouseUp = (upEvt) => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (isMouseDragging) {
        item.classList.remove('dragging');
        const elemUnder = document.elementFromPoint(upEvt.clientX, upEvt.clientY);
        const targetChannelItem = elemUnder ? elemUnder.closest('.channel-item') : null;
        document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('dragging', 'drag-over'));

        if (targetChannelItem) {
          const targetId = targetChannelItem.dataset.id;
          if (targetId && targetId !== room.id) {
            executeChannelSwap(room.id, targetId, room.type);
          }
        }
        activeDragChannelId = null;
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function executeChannelSwap(sourceId, targetId, channelType) {
  if (!sourceId || !targetId || sourceId === targetId || !lastFetchedRooms) return;

  const sourceRoom = lastFetchedRooms.find(r => r.id === sourceId);
  const targetRoom = lastFetchedRooms.find(r => r.id === targetId);

  if (!sourceRoom || !targetRoom || sourceRoom.type !== channelType || targetRoom.type !== channelType) return;

  const fromIdx = lastFetchedRooms.findIndex(r => r.id === sourceId);
  const toIdx = lastFetchedRooms.findIndex(r => r.id === targetId);

  if (fromIdx !== -1 && toIdx !== -1) {
    const [movedRoom] = lastFetchedRooms.splice(fromIdx, 1);
    lastFetchedRooms.splice(toIdx, 0, movedRoom);

    // Re-render locally with 0ms delay
    renderChannelList(lastFetchedRooms);

    // Emit to server
    const newOrderIds = lastFetchedRooms.map(r => r.id);
    if (socket && socket.connected) {
      socket.emit('reorder-channels', { channelIds: newOrderIds });
    }
  }
}

// Rebuilding the whole sidebar tears down every channel row plus its click,
// contextmenu and drag-and-drop listeners. It used to run on every incoming
// message, every mute toggle by anyone, and every voice-occupant broadcast.
// Two guards fix that: a cheap signature so identical state is a no-op, and
// rAF coalescing so a burst of triggers paints once.
//
// isTalking is deliberately NOT part of the signature - it changes many times
// a second while someone speaks and is applied directly by setTalkingStatus().
//
// Avatars are base64 data URLs; hashing the whole string on every signature
// would defeat the point, so a length + tail sample stands in for it. That is
// enough to notice a *replaced* avatar without walking hundreds of KB.
function stripLeadingSpeakerGlyph(name) {
  return String(name || '').replace(/^\s*[\u{1F508}-\u{1F50A}]\s*/u, '');
}

function avatarFingerprint(avatar) {
  if (!avatar) return '0';
  return `${avatar.length}:${avatar.slice(-16)}`;
}

function computeChannelListSignature(rooms) {
  const parts = [currentTextRoom, currentVoiceRoom];
  for (const room of rooms) {
    parts.push(room.id, room.name, room.type, mutedChannels[room.id] ? 1 : 0, unreadCounts[room.id] || 0);
    if (room.type === 'voice') {
      const occupants = voiceOccupantsMap[room.id] || [];
      for (const occ of occupants) {
        const peer = voiceManager ? voiceManager.peers.get(occ.socketId) : null;
        parts.push(
          occ.socketId,
          getSimpleDisplayName(occ.username),
          avatarFingerprint(occ.avatar),
          occ.isMuted ? 1 : 0,
          occ.isDeafened ? 1 : 0,
          occ.isScreenSharing ? 1 : 0,
          peer && peer.volume === 0 ? 1 : 0
        );
      }
    }
  }
  return parts.join('');
}

let lastChannelListSignature = null;
let channelListRenderRAF = null;

function scheduleChannelListRender() {
  if (!lastFetchedRooms || channelListRenderRAF !== null) return;
  channelListRenderRAF = requestAnimationFrame(() => {
    channelListRenderRAF = null;
    if (lastFetchedRooms) renderChannelList(lastFetchedRooms);
  });
}

function renderChannelList(rooms, force = false) {
  if (channelListRenderRAF !== null) {
    cancelAnimationFrame(channelListRenderRAF);
    channelListRenderRAF = null;
  }

  const signature = computeChannelListSignature(rooms);
  if (!force && signature === lastChannelListSignature) return;
  lastChannelListSignature = signature;

  textChannelsContainer.innerHTML = '';
  voiceChannelsContainer.innerHTML = '';

  rooms.forEach(room => {
    const isMuted = !!mutedChannels[room.id];
    const mutedBellSvg = isMuted ? `<span class="muted-bell-icon" title="Sessize Alındı"><svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><line x1="1" y1="1" x2="23" y2="23"/></svg></span>` : '';

    if (room.type === 'text') {
      const item = document.createElement('div');
      item.className = `channel-item${isMuted ? ' muted-channel' : ''}`;
      item.dataset.id = room.id;
      if (room.id === currentTextRoom) item.classList.add('active');
      const unread = unreadCounts[room.id] || 0;
      const badgeHtml = unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : '';
      item.innerHTML = `<span class="channel-icon">#</span> <span>${escapeHtml(room.name)}</span>${mutedBellSvg}${badgeHtml}`;
      item.addEventListener('click', () => {
        if (callViewOpen) closeCallView();
        joinTextRoom(room.id, room.name);
      });

      attachChannelDragAndDrop(item, room);

      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        targetChannelForAction = room;
        if (ctxMuteText) {
          ctxMuteText.textContent = mutedChannels[room.id] ? 'Kanalın Sesini Aç' : 'Kanalı Sessize Al';
        }
        // Channel management is admin-only (enforced server-side too).
        const isAdmin = isAdminUser();
        if (ctxDelete) ctxDelete.classList.toggle('hidden', !isAdmin);
        if (ctxRename) ctxRename.classList.toggle('hidden', !isAdmin);
        contextMenu.classList.remove('hidden');
        const menuW = contextMenu.offsetWidth || 160;
        const menuH = contextMenu.offsetHeight || 120;
        let x = e.clientX;
        let y = e.clientY;
        if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 12;
        if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 12;
        if (x < 12) x = 12;
        if (y < 12) y = 12;
        contextMenu.style.left = `${x}px`;
        contextMenu.style.top = `${y}px`;
      });

      textChannelsContainer.appendChild(item);
    } else if (room.type === 'voice') {
      const item = document.createElement('div');
      item.className = `channel-item${isMuted ? ' muted-channel' : ''}`;
      item.dataset.id = room.id;
      if (room.id === currentVoiceRoom) item.classList.add('active');
      // The row already renders its own speaker glyph, so a name that also
      // starts with one (the seeded "🔊 Ses Odası 1" rooms do) would show two.
      item.innerHTML = `<span class="channel-icon">🔊</span> <span>${escapeHtml(stripLeadingSpeakerGlyph(room.name))}</span>${mutedBellSvg}`;
      item.addEventListener('click', async () => {
        if (currentVoiceRoom === room.id) {
          openCallView();
          return;
        }
        await joinVoiceRoom(room.id, room.name);
        openCallView();
      });

      attachChannelDragAndDrop(item, room);

      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        targetChannelForAction = room;
        if (ctxMuteText) {
          ctxMuteText.textContent = mutedChannels[room.id] ? 'Kanalın Sesini Aç' : 'Kanalı Sessize Al';
        }
        // Only an admin may rename/delete channels, and CS2 ROOM can't be
        // deleted at all - server.js enforces both; this just keeps the menu
        // from offering actions that would only come back as an error.
        const isCs2Room = room.id === SFU_ROOM_ID;
        const isAdmin = isAdminUser();
        if (ctxDelete) ctxDelete.classList.toggle('hidden', isCs2Room || !isAdmin);
        if (ctxRename) ctxRename.classList.toggle('hidden', !isAdmin);
        contextMenu.classList.remove('hidden');
        const menuW = contextMenu.offsetWidth || 160;
        const menuH = contextMenu.offsetHeight || 120;
        let x = e.clientX;
        let y = e.clientY;
        if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 12;
        if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 12;
        if (x < 12) x = 12;
        if (y < 12) y = 12;
        contextMenu.style.left = `${x}px`;
        contextMenu.style.top = `${y}px`;
      });

      voiceChannelsContainer.appendChild(item);

      const occupants = voiceOccupantsMap[room.id] || [];
      if (occupants.length > 0) {
        const occContainer = document.createElement('div');
        occContainer.className = 'voice-channel-occupants';

        occupants.forEach(occ => {
          const occItem = document.createElement('div');
          occItem.className = 'sidebar-voice-user';
          occItem.dataset.socketId = occ.socketId;
          const isInMyRoom = room.id === currentVoiceRoom;
          if (occ.isTalking && isInMyRoom) {
            occItem.classList.add('talking');
          }

          let badgesHtml = '';
          if (occ.isMuted) {
            badgesHtml += `<span class="status-badge" style="padding:1px 3px;" title="Mikrofon Kapalı"><svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" stroke-width="2" fill="none"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><line x1="12" y1="19" x2="12" y2="22"/></svg></span>`;
          }
          if (occ.isDeafened) {
            badgesHtml += `<span class="status-badge" style="padding:1px 3px;" title="Kulaklık Kapalı"><svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" stroke-width="2" fill="none"><line x1="1" y1="1" x2="23" y2="23"/><path d="M3 18v-6a9 9 0 0 1 14.85-6.85"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg></span>`;
          }

          const peer = voiceManager ? voiceManager.peers.get(occ.socketId) : null;
          if (peer && peer.volume === 0) {
            badgesHtml += `<span class="status-badge local-mute" style="padding:1px 3px;" title="Tarafınızca Susturuldu"><svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" stroke-width="2" fill="none"><line x1="1" y1="1" x2="23" y2="23"/><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M23 9l-6 6"/><path d="M17 9l6 6"/></svg></span>`;
          }

          const occAvatarHtml = occ.avatar
            ? `<img src="${safeImgSrc(occ.avatar)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
            : (occ.username || 'U').charAt(0).toUpperCase();

          const liveDot = occ.isScreenSharing
            ? '<span class="sidebar-live-dot" title="Canlı Yayında"></span>'
            : '';

          occItem.innerHTML = `
            <div class="sidebar-user-avatar">${occAvatarHtml}</div>
            <span class="sidebar-user-name">${escapeHtml(getSimpleDisplayName(occ.username))}</span>
            ${liveDot}
            ${badgesHtml}
          `;

          occItem.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (voiceManager && voiceManager.peers.has(occ.socketId)) {
              openUserContextMenu(occ.socketId, occ.username, e.clientX, e.clientY, true);
            }
          });

          occContainer.appendChild(occItem);
        });

        voiceChannelsContainer.appendChild(occContainer);
      }
    }
  });
}

// "dm_<a>_<b>" -> the username of whichever participant isn't me, or null.
function getDmPeerName(roomId) {
  const m = /^dm_(\d+)_(\d+)$/.exec(String(roomId || ''));
  if (!m) return null;
  const myId = currentUser ? Number(currentUser.id) : null;
  const peerId = Number(m[1]) === myId ? Number(m[2]) : Number(m[1]);
  const peer = (allUsersCache || []).find(u => Number(u.id) === peerId)
    || (myFriendsList || []).find(f => Number(f.id) === peerId);
  return peer && peer.username ? peer.username : null;
}

function joinTextRoom(roomId, roomName) {
  // Leave previous text room on server side
  if (currentTextRoom && currentTextRoom !== roomId && socket && socket.connected) {
    socket.emit('leave-text-room', currentTextRoom);
  }

  currentTextRoom = roomId;

  if (!roomName) {
    const activeItem = document.querySelector(`#text-channels .channel-item[data-id="${roomId}"] span:last-child`);
    if (activeItem) roomName = activeItem.textContent;
  }

  // A DM's stored name is "@a & @b" - show the other person instead of a
  // "#@a & @b" channel title, the way a direct conversation should read.
  const dmPeerName = getDmPeerName(roomId);
  const hashtagElem = currentChannelNameElem.parentElement?.querySelector('.hashtag');
  if (hashtagElem) hashtagElem.textContent = dmPeerName ? '@' : '#';
  if (dmPeerName) {
    currentChannelNameElem.textContent = dmPeerName;
    chatInput.placeholder = `@${dmPeerName} kişisine mesaj gönder...`;
  } else {
    currentChannelNameElem.textContent = roomName || roomId;
    chatInput.placeholder = `#${roomName || roomId} kanalına mesaj gönder...`;
  }

  document.querySelectorAll('#text-channels .channel-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === roomId);
  });

  // Reset unread count for this room
  unreadCounts[roomId] = 0;
  saveUnreadStateToStorage();
  scheduleChannelListRender();
  // scheduleChannelListRender() only redraws the channel/voice groups - the
  // sidebar's "Son Mesajlar" (recent DMs) list is a separate render path and
  // was otherwise left showing a stale unread badge after opening a DM.
  if (roomId && roomId.startsWith('dm_')) {
    renderFriendsDMList();
    updateFriendsTabBadge();
  }

  // Clear typing indicator when switching rooms
  typingUsers = {};
  updateTypingIndicator();

  // Instant Cache rendering: if cached messages exist for this room, render them immediately!
  const cachedMessages = messageCache[roomId];
  if (messagesContainer) {
    if (cachedMessages && cachedMessages.length > 0) {
      renderMessages(cachedMessages); // already scrolls to bottom
    } else {
      clearRenderedMessages();
      messagesContainer.insertAdjacentHTML('afterbegin', `
        <div class="chat-loading-placeholder">
          <span class="chat-placeholder-spinner" aria-hidden="true"></span>
          <span>Mesajlar yükleniyor...</span>
        </div>
      `);
    }
  }

  if (socket && socket.connected) {
    socket.emit('join-text-room', roomId);
  }
}

function setVoiceConnectionState(state) {
  const connectedTitle = document.getElementById('voice-connected-title');
  const statusDot = document.getElementById('voice-status-dot');

  if (state === 'connecting') {
    if (connectedTitle) {
      connectedTitle.textContent = 'Bağlanıyor...';
      connectedTitle.classList.add('connecting');
    }
    if (statusDot) {
      statusDot.className = 'pulse-yellow';
    }
  } else if (state === 'connected') {
    if (connectedTitle) {
      // Kept short on purpose: at the sidebar's default width the longer
      // wording was ellipsised down to "Ses Bağlantısı A...".
      connectedTitle.textContent = 'Bağlantı Aktif';
      connectedTitle.classList.remove('connecting');
    }
    if (statusDot) {
      statusDot.className = 'pulse-green';
    }
  }
}

async function joinVoiceRoom(roomId, roomName) {
  if (currentVoiceRoom === roomId) return;

  forgetAllStreams();

  currentVoiceRoom = roomId;
  voiceRoomNameElem.textContent = roomName || roomId;
  if (callViewRoomTitle) callViewRoomTitle.textContent = roomName || roomId;

  setVoiceConnectionState('connecting');
  voiceStatusBar.classList.remove('hidden');

  document.querySelectorAll('#voice-channels .channel-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === roomId);
  });

  try {
    await voiceManager.joinVoiceRoom(roomId, username);
    setVoiceConnectionState('connected');
    updateScreenShareButtonUI();
    updateCameraButtonUI();
    syncMicDeafenButtonsUI(voiceManager.isMuted, voiceManager.isDeafened);
    updateVoiceGrid();
  } catch (err) {
    console.error('Failed to join voice room:', err);
    disconnectVoice();
    // A browser/OS-level mic block is remembered per-origin, so the native
    // permission prompt never reappears on its own - re-attempting
    // getUserMedia here would just fail silently again. Instead, surface
    // this every single time the user tries to join voice while blocked, so
    // they get a way out instead of a silent no-op.
    if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.name === 'SecurityError')) {
      const howTo = isRunningInTauri
        ? 'Windows Ayarları → Gizlilik ve Güvenlik → Mikrofon bölümünden AnucVC\'ye izin verip uygulamayı yeniden başlat, sonra tekrar dene.'
        : 'Adres çubuğundaki kilit/site bilgisi simgesine tıklayıp Mikrofon iznini "İzin Ver" yap, sonra tekrar dene.';
      showAppAlert(`Mikrofon izni engellenmiş görünüyor. Sesli sohbete katılmak için mikrofon erişimi gerekiyor. ${howTo}`, 'Mikrofon Erişimi Engelli');
    }
  }
}

function disconnectVoice() {
  if (voiceManager) {
    voiceManager.leaveVoiceRoom();
  }
  currentVoiceRoom = null;
  voiceStatusBar.classList.add('hidden');
  closeCallView();

  forgetAllStreams();
  updateScreenShareButtonUI();
  updateCameraButtonUI();

  document.querySelectorAll('#voice-channels .channel-item').forEach(el => {
    el.classList.remove('active');
  });
}

// Called many times a second while people speak, so it targets exactly the
// rows it needs by attribute selector instead of scanning every tile and every
// sidebar row on each toggle.
function setTalkingStatus(socketId, isTalking) {
  const isLocal = socketId === 'local' || (socket && socket.id === socketId);
  const ids = isLocal
    ? ['local', socket?.id, socketId].filter(Boolean)
    : [socketId];
  const selector = ids.map(id => `[data-socket-id="${CSS.escape(String(id))}"]`).join(',');
  if (!selector) return;

  // 1. Tiles in the call view grid (if open)
  if (callViewGrid) {
    callViewGrid.querySelectorAll(selector).forEach(tile => {
      if (tile.classList.contains('call-tile')) tile.classList.toggle('talking', !!isTalking);
    });
  }

  // 2. Sidebar occupant rows - only glow for occupants in the SAME voice room
  // the current user is actually connected to, otherwise every voice channel's
  // talking indicators light up even when the user isn't in that channel.
  const inMyRoom = isLocal || (voiceManager && voiceManager.peers.has(socketId));
  voiceChannelsContainer?.querySelectorAll(selector).forEach(occItem => {
    if (occItem.classList.contains('sidebar-voice-user')) {
      occItem.classList.toggle('talking', !!isTalking && !!inMyRoom);
    }
  });
}

// Reconciles the call grid instead of rebuilding it. The old version cleared
// callViewGrid and re-created every tile - including every <video> element -
// whenever anyone toggled their mic. That detached live MediaStreams and made
// remote video visibly flicker/restart on each status change, on top of the
// wasted layout work. Now a tile is only re-created when its *content* changes
// (avatar <-> camera <-> screen share, or a different stream); name, badges
// and talking state are patched in place.
let voiceGridRenderRAF = null;

function scheduleVoiceGridRender() {
  if (voiceGridRenderRAF !== null) return;
  voiceGridRenderRAF = requestAnimationFrame(() => {
    voiceGridRenderRAF = null;
    updateVoiceGrid();
  });
}

// A screen share gets a descriptor of its own, placed right after its owner's,
// so sharing and having the camera on produce two side-by-side bubbles instead
// of the share hiding the person.
function collectCallTileDescriptors() {
  const descriptors = [];
  if (!voiceManager) return descriptors;

  const isLive = (stream) => !!(stream && stream.getVideoTracks().some(t => t.readyState === 'live'));

  const localId = socket ? socket.id : 'local';
  descriptors.push({
    kind: 'user',
    tileId: `user:${localId}`,
    socketId: localId,
    displayName: username,
    avatar: userAvatar,
    isMuted: voiceManager.isMuted,
    isDeafened: voiceManager.isDeafened,
    isTalking: voiceManager.isTalking,
    cameraStream: voiceManager.isCameraOn && isLive(voiceManager.cameraStream) ? voiceManager.cameraStream : null,
    isLocal: true
  });

  const localScreen = voiceManager.isScreenSharing && isLive(voiceManager.screenStream) ? voiceManager.screenStream : null;
  if (localScreen) {
    descriptors.push({
      kind: 'screen',
      tileId: `screen:${LOCAL_STREAM_OWNER}`,
      ownerId: LOCAL_STREAM_OWNER,
      screenStream: localScreen,
      isLocal: true
    });
  }

  for (const [socketId, peerObj] of voiceManager.peers.entries()) {
    descriptors.push({
      kind: 'user',
      tileId: `user:${socketId}`,
      socketId,
      displayName: peerObj.username,
      avatar: peerObj.avatar,
      isMuted: peerObj.isMuted,
      isDeafened: peerObj.isDeafened,
      isTalking: peerObj.isTalking,
      cameraStream: isLive(peerObj.cameraStream) ? peerObj.cameraStream : null,
      isLocal: false
    });

    const peerScreen = isLive(peerObj.screenStream) ? peerObj.screenStream : null;
    if (peerScreen) {
      descriptors.push({
        kind: 'screen',
        tileId: `screen:${socketId}`,
        ownerId: socketId,
        screenStream: peerScreen,
        isLocal: false
      });
    }
  }

  return descriptors;
}

// Identifies what a tile is *showing*. Only a change here forces a rebuild.
function callTileContentKey(d) {
  if (d.kind === 'screen') return `screen:${d.screenStream.id}`;
  if (d.cameraStream) return `camera:${d.cameraStream.id}`;
  return `avatar:${avatarFingerprint(d.avatar)}`;
}

function updateVoiceGrid() {
  if (voiceGridRenderRAF !== null) {
    cancelAnimationFrame(voiceGridRenderRAF);
    voiceGridRenderRAF = null;
  }
  if (!callViewGrid) return;
  if (!callViewOpen) return; // nothing to render while minimized; openCallView() re-renders on open
  if (!voiceManager) {
    callViewGrid.replaceChildren();
    return;
  }

  const descriptors = collectCallTileDescriptors();
  // The header count is the number of people in the call, so stream tiles are
  // deliberately not counted.
  if (callViewCount) callViewCount.textContent = String(descriptors.filter(d => d.kind === 'user').length);

  const existing = new Map();
  for (const el of callViewGrid.children) {
    if (el.dataset && el.dataset.tileId) existing.set(el.dataset.tileId, el);
  }

  let previous = null;
  for (const d of descriptors) {
    const key = String(d.tileId);
    const contentKey = callTileContentKey(d);
    let tile = existing.get(key);

    if (tile && tile._contentKey !== contentKey) {
      tile.remove();
      tile = null;
    }

    if (!tile) {
      tile = buildCallTile(d);
      tile._contentKey = contentKey;
      // Stream tiles bring their own context menu (stream volume + watching);
      // wireStreamTile() attached it when the tile was built.
      if (d.kind === 'user' && !d.isLocal) {
        tile.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openUserContextMenu(d.socketId, d.displayName, e.clientX, e.clientY, true);
        });
      }
    } else {
      patchCallTile(tile, d);
      existing.delete(key);
    }

    // Place it in the right slot without touching tiles already in order.
    const shouldFollow = previous ? previous.nextSibling : callViewGrid.firstChild;
    if (tile !== shouldFollow) callViewGrid.insertBefore(tile, shouldFollow);
    previous = tile;
  }

  // Anything left over belongs to peers who are gone.
  for (const stale of existing.values()) stale.remove();

  syncAllStreamTiles();
  applyCallViewTileLayout();
}

// In-place update for a tile whose content element is being kept.
function patchCallTile(tile, d) {
  if (d.kind === 'screen') {
    const streamName = tile.querySelector('.call-tile-name');
    const title = streamDisplayTitle(d.ownerId);
    if (streamName && streamName.textContent !== title) streamName.textContent = title;
    return;
  }

  const resolvedName = getSimpleDisplayName(d.displayName);
  const finalDisplayName = d.isLocal ? `${resolvedName} (Sen)` : resolvedName;

  const nameElem = tile.querySelector('.call-tile-name');
  if (nameElem && nameElem.textContent !== finalDisplayName) nameElem.textContent = finalDisplayName;

  const badgesElem = tile.querySelector('.call-tile-badges');
  const badgesHtml = buildCallTileBadges(d.isMuted, d.isDeafened);
  if (badgesElem && badgesElem.innerHTML !== badgesHtml) badgesElem.innerHTML = badgesHtml;

  tile.classList.toggle('talking', !!d.isTalking);
}

// Computes the tile size (cols/rows and pixel dimensions) that maximizes
// each tile's area while guaranteeing the whole set fits within the
// container - this is what actually prevents tiles from overlapping at
// smaller window sizes (a fixed aspect-ratio + CSS Grid row can't guarantee
// that on its own, since the row height and the aspect-ratio-driven height
// can disagree).
function getMaxTileWidthForCount(count) {
  if (count <= 1) return 640;
  if (count === 2) return 440;
  if (count <= 4) return 300;
  if (count <= 6) return 230;
  if (count <= 9) return 180;
  if (count <= 12) return 150;
  return 120;
}

function computeCallTileLayout(containerWidth, containerHeight, count, gap = 16, targetAspectRatio = 16 / 10) {
  if (count <= 0 || containerWidth <= 0 || containerHeight <= 0) {
    return { tileWidth: 280, tileHeight: 175 };
  }

  // Cap tile size by participant count so a small call doesn't blow each tile
  // up to nearly the full width. The cap has to be applied inside the loop,
  // not to the winner afterwards: applied afterwards it shrank the tiles of an
  // already-chosen single-column layout, and the grid then had room for a row
  // it was never asked to consider - which is why two people in a wide window
  // ended up as a tall stack with empty space either side.
  const maxTileWidth = getMaxTileWidthForCount(count);
  let best = { tileWidth: 0, tileHeight: 0, area: 0, rows: Infinity };

  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cellWidth = (containerWidth - gap * (cols - 1)) / cols;
    const cellHeight = (containerHeight - gap * (rows - 1)) / rows;
    if (cellWidth <= 0 || cellHeight <= 0) continue;

    let tileWidth = Math.min(cellWidth, maxTileWidth);
    let tileHeight = tileWidth / targetAspectRatio;
    if (tileHeight > cellHeight) {
      tileHeight = cellHeight;
      tileWidth = Math.min(cellHeight * targetAspectRatio, maxTileWidth);
      tileHeight = tileWidth / targetAspectRatio;
    }

    const area = tileWidth * tileHeight;
    // Bigger tiles win, but once the cap makes several layouts effectively the
    // same size, the flatter one wins - people read a call as a row of faces,
    // not a column of them.
    const clearlyBigger = area > best.area * 1.02;
    const sameSizeButFlatter = area >= best.area * 0.9 && rows < best.rows;
    if (best.area === 0 || clearlyBigger || sameSizeButFlatter) {
      best = { tileWidth, tileHeight, area, rows };
    }
  }

  return best;
}

function applyCallViewTileLayout() {
  if (!callViewGrid || !callViewOpen) return;
  const tiles = callViewGrid.querySelectorAll('.call-tile');
  if (!tiles.length) return;

  // The grid's border box includes its own padding, which the tiles cannot
  // use. Measuring that instead of the content box overstated the available
  // width by the full horizontal padding, so a layout that "fit" on paper
  // overflowed by a few pixels and flex-wrap pushed the last tile onto its
  // own row - two people in a wide window ended up stacked with empty space
  // either side of them.
  const rect = callViewGrid.getBoundingClientRect();
  const cs = getComputedStyle(callViewGrid);
  const innerWidth = rect.width - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
  const innerHeight = rect.height - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);
  const gap = parseFloat(cs.columnGap || cs.gap || 16) || 16;
  const { tileWidth, tileHeight } = computeCallTileLayout(innerWidth, innerHeight, tiles.length, gap);

  tiles.forEach(tile => {
    tile.style.width = `${Math.floor(tileWidth)}px`;
    tile.style.height = `${Math.floor(tileHeight)}px`;
  });
}

let callViewResizeRAF = null;
window.addEventListener('resize', () => {
  if (!callViewOpen) return;
  if (callViewResizeRAF) cancelAnimationFrame(callViewResizeRAF);
  callViewResizeRAF = requestAnimationFrame(applyCallViewTileLayout);
});

function getSimpleDisplayName(rawUsername) {
  if (!rawUsername) return '';
  const customNick = userNicknames[rawUsername.toLowerCase()];
  return customNick || rawUsername;
}

function buildCallTileBadges(isMuted, isDeafened) {
  let html = '';
  if (isMuted) {
    html += `<span class="call-tile-badge mic-off" title="Mikrofon Kapalı"><svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="22"/></svg></span>`;
  }
  if (isDeafened) {
    html += `<span class="call-tile-badge deaf-off" title="Kulaklık Kapalı"><svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none"><line x1="1" y1="1" x2="23" y2="23"/><path d="M3 18v-6a9 9 0 0 1 14.85-6.85"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg></span>`;
  }
  return html;
}

function buildCallTile(d) {
  if (d.kind === 'screen') return buildStreamTile(d);
  const { socketId, displayName, avatar, isMuted, isDeafened, isTalking, cameraStream, isLocal } = d;

  const tile = document.createElement('div');
  tile.className = 'call-tile';
  tile.dataset.tileId = d.tileId;
  tile.dataset.socketId = socketId;
  if (isTalking) tile.classList.add('talking');

  const resolvedName = getSimpleDisplayName(displayName);
  const finalDisplayName = isLocal ? `${resolvedName} (Sen)` : resolvedName;

  const initial = (resolvedName || 'U').charAt(0).toUpperCase();
  const avatarHtml = avatar ? `<img src="${safeImgSrc(avatar)}" alt="" />` : initial;

  const badgesHtml = buildCallTileBadges(isMuted, isDeafened);

  const mainContentHtml = cameraStream
    ? `<video autoplay playsinline${isLocal ? ' muted class="call-tile-video-mirrored"' : ''}></video>`
    : `<div class="call-tile-avatar-wrap"><div class="call-tile-avatar">${avatarHtml}</div></div>`;

  tile.innerHTML = `
    ${mainContentHtml}
    <div class="call-tile-footer">
      <span class="call-tile-name">${escapeHtml(finalDisplayName)}</span>
      <span class="call-tile-badges">${badgesHtml}</span>
    </div>
  `;

  if (cameraStream) {
    const videoEl = tile.querySelector('video');
    if (videoEl) {
      videoEl.srcObject = cameraStream;
      videoEl.play().catch(() => {});
    }
  }

  return tile;
}

function buildStreamTile({ tileId, ownerId }) {
  const tile = document.createElement('div');
  tile.className = 'call-tile call-tile-stream';
  tile.dataset.tileId = tileId;
  tile.dataset.streamOwner = String(ownerId);
  tile.innerHTML = buildStreamTileHtml(ownerId, streamDisplayTitle(ownerId));
  wireStreamTile(tile, ownerId);
  return tile;
}

async function sendDesktopNotification(title, body) {
  try {
    // 1. Try Tauri Native Desktop Notification
    if (window.__TAURI__ || window.__TAURI_IPC__ || window.__TAURI_INTERNALS__) {
      try {
        const { sendNotification, isPermissionGranted, requestPermission } = await import('@tauri-apps/api/notification');
        let granted = await isPermissionGranted();
        if (!granted) {
          const permission = await requestPermission();
          granted = permission === 'granted';
        }
        if (granted) {
          sendNotification({ title, body });
          // Clicking the OS toast itself already brings AnucVC to the
          // foreground (default OS behavior for a running app's own
          // notification) - this just adds a taskbar flash on top of that
          // while the window isn't focused, so it's noticeable even before
          // it's clicked. Skipped while already focused since a window
          // flashing at you while you're looking right at it is just noise.
          if (!document.hasFocus()) {
            try {
              const appWindow = window.__TAURI__.window?.appWindow || window.__TAURI__.window?.getCurrent();
              if (appWindow && typeof appWindow.requestUserAttention === 'function') {
                appWindow.requestUserAttention(1); // UserAttentionType.Critical
              }
            } catch (e) {}
          }
          return;
        }
      } catch (tauriErr) {
        console.log('Tauri notification API fallback:', tauriErr);
      }
    }

    // 2. Standard Web & WebView HTML5 Notification Fallback
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification(title, { body });
      } else if (Notification.permission !== 'denied') {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          new Notification(title, { body });
        }
      }
    }
  } catch (e) {
    console.log('Desktop notification error:', e);
  }
}

const mentionAutocompleteElem = document.getElementById('mention-autocomplete');

function getMentionQueryAtCursor() {
  const value = chatInput.value;
  const cursor = chatInput.selectionStart || value.length;
  const uptoCursor = value.slice(0, cursor);
  const match = uptoCursor.match(/(?:^|\s)@([a-zA-Z0-9_\. \-şŞğĞıİöÖçÇüÜ#]*)$/);
  if (!match) return null;
  const queryStart = uptoCursor.lastIndexOf('@' + match[1]);
  return { query: match[1], queryStart };
}

function handleMentionInput() {
  const found = getMentionQueryAtCursor();
  if (!found) {
    closeMentionDropdown();
    return;
  }

  mentionQueryStart = found.queryStart;
  const query = found.query.toLowerCase().replace(/^#/, '');

  const results = [];

  const userResults = [];

  allUsersCache.forEach(u => {
    const uname = (u.username || '').toLowerCase();
    // Do NOT include self in mention autocomplete suggestions
    if (uname === (username || '').toLowerCase()) return;

    const tag = formatUserTag(u.id).replace('#', '');
    const nick = (userNicknames[uname] || '').toLowerCase();

    if (query === '' || uname.includes(query) || (nick && nick.includes(query)) || tag.includes(query)) {
      const isOnline = onlineUsernamesSet.has(uname);
      const isFriend = myFriendsSet.has(uname);

      // Score for ordering: Çevrimiçiler (10) > Arkadaşlar (5) > Çevrimdışılar (0)
      let score = 0;
      if (isOnline) score += 10;
      if (isFriend) score += 5;

      userResults.push({ type: 'user', id: u.id, username: u.username, avatar: u.avatar, isOnline, isFriend, score });
    }
  });

  userResults.sort((a, b) => b.score - a.score);

  if ('all'.startsWith(query) || query === '') {
    results.push({ type: 'all' });
  }

  results.push(...userResults);

  mentionCurrentResults = results.slice(0, 8);
  mentionSelectedIndex = 0;

  if (mentionCurrentResults.length === 0) {
    closeMentionDropdown();
    return;
  }

  mentionActive = true;
  renderMentionDropdown();
}

function renderMentionDropdown() {
  if (!mentionAutocompleteElem) return;
  if (!mentionActive || mentionCurrentResults.length === 0) {
    mentionAutocompleteElem.classList.add('hidden');
    return;
  }

  mentionAutocompleteElem.innerHTML = mentionCurrentResults.map((res, idx) => {
    const activeClass = idx === mentionSelectedIndex ? 'active' : '';
    if (res.type === 'all') {
      return `
        <div class="mention-item ${activeClass}" data-idx="${idx}">
          <div class="mention-item-avatar">@</div>
          <span class="mention-item-name">herkes (@all)</span>
        </div>
      `;
    }
    const initial = (res.username || 'U').charAt(0).toUpperCase();
    const avatarHtml = res.avatar
      ? `<img src="${safeImgSrc(res.avatar)}" alt="" />`
      : initial;
    const isOnline = res.isOnline || onlineUsernamesSet.has((res.username || '').toLowerCase());
    const isFriend = res.isFriend || myFriendsSet.has((res.username || '').toLowerCase());

    return `
      <div class="mention-item ${activeClass}" data-idx="${idx}">
        <div class="mention-item-avatar">${avatarHtml}</div>
        <span class="mention-item-name">${getFormattedDisplayName(res.username)} ${isFriend ? '<span class="chestnut-badge" title="Arkadaşınız">🌰</span>' : ''}</span>
        ${isOnline ? '<span class="mention-item-online-dot" title="Çevrimiçi"></span>' : ''}
        <span class="mention-item-tag">${formatUserTag(res.id)}</span>
      </div>
    `;
  }).join('');

  mentionAutocompleteElem.classList.remove('hidden');

  mentionAutocompleteElem.querySelectorAll('.mention-item').forEach(itemElem => {
    itemElem.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const idx = parseInt(itemElem.dataset.idx, 10);
      selectMention(mentionCurrentResults[idx]);
    });
  });
}

function selectMention(result) {
  if (!result || mentionQueryStart < 0) return;
  const value = chatInput.value;
  const cursor = chatInput.selectionStart || value.length;
  const insertText = result.type === 'all' ? '@all ' : `@${result.username} `;

  chatInput.value = value.slice(0, mentionQueryStart) + insertText + value.slice(cursor);
  const newCursorPos = mentionQueryStart + insertText.length;
  chatInput.focus();
  chatInput.setSelectionRange(newCursorPos, newCursorPos);

  closeMentionDropdown();
}

function closeMentionDropdown() {
  mentionActive = false;
  mentionCurrentResults = [];
  mentionQueryStart = -1;
  if (mentionAutocompleteElem) mentionAutocompleteElem.classList.add('hidden');
}

// Resolve any manually-typed id-style mentions (e.g. @0134 or @#0134) into @username
// before sending, so the server's plain-text mention matching works correctly.
function resolveMentionsForSend(text) {
  return text.replace(/@#?(\d{1,6})\b/g, (fullMatch, digits) => {
    const numericId = parseInt(digits, 10);
    const matchedUser = allUsersCache.find(u => u.id === numericId);
    return matchedUser ? `@${matchedUser.username}` : fullMatch;
  });
}

let replyingToMessage = null;

const replyPreviewBar = document.getElementById('reply-preview-bar');
const replyPreviewUser = document.getElementById('reply-preview-user');
const replyPreviewText = document.getElementById('reply-preview-text');
const btnCancelReply = document.getElementById('btn-cancel-reply');

function startReply(msg) {
  replyingToMessage = msg;
  if (replyPreviewUser && replyPreviewText && replyPreviewBar) {
    replyPreviewUser.textContent = `@${msg.username} kişisine yanıt veriliyor`;
    replyPreviewText.textContent = msg.content || (msg.image_data ? '[Görsel]' : '');
    replyPreviewBar.classList.remove('hidden');
    chatInput.focus();
  }
}

function cancelReply() {
  replyingToMessage = null;
  if (replyPreviewBar) {
    replyPreviewBar.classList.add('hidden');
  }
}

function sendMessage() {
  const rawContent = chatInput.value.trim();
  const content = resolveMentionsForSend(rawContent);
  if ((!content && !selectedImageData) || !socket) return;

  socket.emit('send-message', {
    roomId: currentTextRoom,
    content,
    imageData: selectedImageData,
    senderName: username,
    replyTo: replyingToMessage ? {
      id: replyingToMessage.id,
      username: replyingToMessage.username,
      content: replyingToMessage.content || (replyingToMessage.image_data ? '[Görsel]' : '')
    } : null
  });

  socket.emit('stop-typing', { roomId: currentTextRoom });

  chatInput.value = '';
  clearSelectedImage();
  cancelReply();
  closeMentionDropdown();
}

// --- TENOR GIF PICKER LOGIC ---
let gifDebounceTimer = null;

btnToggleGif?.addEventListener('click', (e) => {
  e.stopPropagation();
  const isHidden = gifPickerPopover.classList.contains('hidden');
  if (isHidden) {
    gifPickerPopover.classList.remove('hidden');
    btnToggleGif.classList.add('active');
    gifSearchInput.value = '';
    gifSearchInput.focus();
    loadGifs('');
  } else {
    closeGifPicker();
  }
});

btnCloseGifPicker?.addEventListener('click', closeGifPicker);

function closeGifPicker() {
  gifPickerPopover?.classList.add('hidden');
  btnToggleGif?.classList.remove('active');
}

// Live search as user types (debounced 250ms like Discord/Instagram)
gifSearchInput?.addEventListener('input', (e) => {
  clearTimeout(gifDebounceTimer);
  const query = e.target.value;
  gifDebounceTimer = setTimeout(() => {
    loadGifs(query);
  }, 250);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && gifPickerPopover && !gifPickerPopover.classList.contains('hidden')) {
    closeGifPicker();
  }
});

document.addEventListener('click', (e) => {
  if (gifPickerPopover && !gifPickerPopover.classList.contains('hidden')) {
    if (!gifPickerPopover.contains(e.target) && !btnToggleGif.contains(e.target)) {
      closeGifPicker();
    }
  }
});

// Increments on every search so a slow response for an older query can't
// overwrite the results of the one typed after it.
let gifRequestSeq = 0;

async function loadGifs(query = '') {
  if (!gifPickerResults) return;
  const seq = ++gifRequestSeq;
  gifPickerResults.innerHTML = '<div class="gif-picker-loading">GIPHY GIF\'leri yükleniyor...</div>';

  try {
    const gifs = await fetchGiphyGifs(query);
    if (seq !== gifRequestSeq) return;
    renderGifResults(gifs);
  } catch (err) {
    if (seq !== gifRequestSeq) return;
    console.error('Giphy API error:', err);
    const div = document.createElement('div');
    div.className = 'gif-picker-empty';
    div.textContent = err && err.userMessage ? err.userMessage : 'GIF yüklenirken bir hata oluştu.';
    gifPickerResults.innerHTML = '';
    gifPickerResults.appendChild(div);
  }
}

// GIF search goes through our own server (GET /api/gifs), which holds the
// GIPHY API key - the key used to be hard-coded right here, i.e. shipped to
// every client and published with the source.
async function fetchGiphyGifs(query = '') {
  const params = new URLSearchParams();
  if (query && query.trim()) params.set('q', query.trim());

  const res = await fetch(`${serverUrl}/api/gifs?${params}`, {
    headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    const err = new Error(`GIF HTTP Error: ${res.status}`);
    err.userMessage = data.error || null;
    throw err;
  }
  return (data.gifs || []).filter(g => g.previewUrl && g.fullUrl);
}

function renderGifResults(gifs) {
  if (!gifPickerResults) return;
  gifPickerResults.innerHTML = '';

  if (!gifs || gifs.length === 0) {
    gifPickerResults.innerHTML = '<div class="gif-picker-empty">GIF bulunamadı.</div>';
    return;
  }

  gifs.forEach(gif => {
    const item = document.createElement('div');
    item.className = 'gif-picker-item';
    item.title = gif.title;
    item.innerHTML = `<img src="${safeImgSrc(gif.previewUrl)}" alt="${escapeHtml(gif.title)}" loading="lazy" />`;

    item.addEventListener('click', () => {
      sendGifMessage(gif.fullUrl);
      closeGifPicker();
    });

    gifPickerResults.appendChild(item);
  });
}

function sendGifMessage(gifUrl) {
  if (!currentTextRoom || !socket) return;

  socket.emit('send-message', {
    roomId: currentTextRoom,
    content: '',
    imageData: gifUrl,
    senderName: username,
    replyTo: replyingToMessage ? {
      id: replyingToMessage.id,
      username: replyingToMessage.username,
      content: replyingToMessage.content || (replyingToMessage.image_data ? '[Görsel]' : '')
    } : null
  });

  cancelReply();
}

function distanceFromBottom() {
  return messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
}

function stickToBottomIfPinned() {
  if (!isPinnedToBottom || !messagesContainer) return;
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'instant' });
}

// Row heights are exact now (no content-visibility estimates), so a single
// jump lands on the true bottom. behavior is spelled out as 'instant' so this
// never depends on the container's CSS scroll-behavior.
function scrollToBottom(options = {}) {
  if (!messagesContainer) return;
  isPinnedToBottom = true;
  hideNewMessagesPill();
  const maxTop = messagesContainer.scrollHeight - messagesContainer.clientHeight;
  // Channel switches get a Discord-style entrance: land a little short, then
  // glide the rest of the way.
  if (options.reveal) {
    const revealOffset = Math.min(160, Math.max(0, maxTop));
    if (revealOffset > 4) {
      messagesContainer.scrollTo({ top: maxTop - revealOffset, behavior: 'instant' });
      requestAnimationFrame(() => {
        messagesContainer?.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
      });
      // A busy machine can stall the glide short of the bottom (160px measured
      // under load), which left the list no longer following new messages - so
      // it always ends parked at the bottom unless the reader took over.
      revealInProgress = true;
      clearTimeout(revealSnapTimer);
      revealSnapTimer = setTimeout(() => {
        revealInProgress = false;
        stickToBottomIfPinned();
      }, REVEAL_GLIDE_MS);
      return;
    }
  }
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'instant' });
}

// Jumps to the message a reply quotes and flashes it.
function scrollToMessageAndHighlight(targetId) {
  const el = document.querySelector(`.message-item[data-msg-id="${targetId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  el.classList.remove('highlight-msg');
  void el.offsetWidth;
  el.classList.add('highlight-msg');
}

// Inserts a page of older history above what the reader is looking at without
// moving it. Measuring a visible row before and after the insert covers every
// way the rows above can change height - the new batch, the grouping pass
// re-deciding the old first row, the first-child auto margin moving - whether
// or not the browser's own scroll anchoring already compensated.
function prependOlderMessages(messages) {
  const anchor = findTopVisibleMessage();
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
  const prevScrollTop = messagesContainer.scrollTop;
  const prevScrollHeight = messagesContainer.scrollHeight;
  const fragment = document.createDocumentFragment();
  messages.forEach(msg => {
    const item = createMessageItemElement(msg);
    if (item) fragment.appendChild(item);
  });
  messagesContainer.insertBefore(fragment, messagesContainer.firstChild);
  // The message that used to be first now has a predecessor, so the whole
  // window has to be re-evaluated, not just the newly inserted rows.
  applyMessageGrouping();
  const top = anchor && anchor.isConnected
    ? messagesContainer.scrollTop + (anchor.getBoundingClientRect().top - anchorTop)
    : prevScrollTop + (messagesContainer.scrollHeight - prevScrollHeight);
  messagesContainer.scrollTo({ top, behavior: 'instant' });
}

function findTopVisibleMessage() {
  const viewTop = messagesContainer.getBoundingClientRect().top;
  for (const el of messagesContainer.children) {
    if (el.classList.contains('msg-item') && el.getBoundingClientRect().bottom > viewTop) return el;
  }
  return null;
}

function showNewMessagesPill() {
  if (!messagesContainer) return;
  if (!newMessagesPill) {
    newMessagesPill = document.createElement('button');
    newMessagesPill.type = 'button';
    newMessagesPill.className = 'new-messages-pill';
    newMessagesPill.addEventListener('click', () => scrollToBottom());
    // Lives in the (position:relative) chat area rather than in the list, so
    // re-renders and the grouping pass never have to know about it.
    messagesContainer.parentElement.appendChild(newMessagesPill);
  }
  newMessagesPill.textContent = unseenMessagesCount > 1 ? `↓ ${unseenMessagesCount} yeni mesaj` : '↓ Yeni mesaj';
  newMessagesPill.hidden = false;
  positionNewMessagesPill();
}

function hideNewMessagesPill() {
  unseenMessagesCount = 0;
  if (newMessagesPill) newMessagesPill.hidden = true;
}

// Just above the list's bottom edge, whatever is open underneath it (typing
// indicator, reply bar, image preview).
function positionNewMessagesPill() {
  if (!newMessagesPill || newMessagesPill.hidden || !messagesContainer) return;
  const wrapperBottom = messagesContainer.parentElement.getBoundingClientRect().bottom;
  const listBottom = messagesContainer.getBoundingClientRect().bottom;
  newMessagesPill.style.bottom = `${Math.round(wrapperBottom - listBottom + 12)}px`;
}

// SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker, which
// every browser would otherwise read as local time and shift by the timezone
// offset. Normalising it here keeps both the printed clock time and the
// message-grouping window below working off the same instant.
function parseMessageTime(ts) {
  if (!ts) return null;
  let date;
  if (typeof ts === 'string') {
    let isoStr = ts.trim();
    if (isoStr.includes(' ') && !isoStr.includes('T')) {
      isoStr = isoStr.replace(' ', 'T');
    }
    if (!isoStr.endsWith('Z') && !isoStr.includes('+')) {
      isoStr += 'Z';
    }
    date = new Date(isoStr);
  } else {
    date = new Date(ts);
  }
  if (isNaN(date.getTime())) date = new Date(ts);
  return isNaN(date.getTime()) ? null : date;
}

function formatMessageTime(ts) {
  const date = parseMessageTime(ts);
  if (!date) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Consecutive messages from the same person, close together in time, collapse
// into one visual block: only the first one carries an avatar and a name row,
// the rest are indented continuation lines with the time revealed on hover.
// Anything that needs its own header (a reply, an image) always starts a new
// block so it can't be mistaken for part of the message above it.
const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

function shouldGroupWithPrevious(prevEl, el) {
  if (!prevEl || !prevEl.classList.contains('msg-item')) return false;
  if (el.dataset.startsBlock === '1') return false;
  if (!el.dataset.author || prevEl.dataset.author !== el.dataset.author) return false;
  const prevTs = Number(prevEl.dataset.ts || 0);
  const ts = Number(el.dataset.ts || 0);
  if (!prevTs || !ts) return false;
  return ts - prevTs >= 0 && ts - prevTs < MESSAGE_GROUP_WINDOW_MS;
}

// Cheap enough to redo for the whole rendered window (capped at
// MAX_RENDERED_MESSAGES) after any batch insert, and that way a prepend of
// older messages also re-decides the boundary item that used to be first.
function applyMessageGrouping(root) {
  const container = root || messagesContainer;
  if (!container) return;
  let prev = null;
  for (const el of container.children) {
    if (!el.classList.contains('msg-item')) continue;
    el.classList.toggle('is-grouped', shouldGroupWithPrevious(prev, el));
    prev = el;
  }
}

// Repaints the avatar (and the rendered name) of every message by a given
// author after their profile changes. Used to walk the DOM looking for a
// `.msg-author` element that has never existed in the markup - the class is
// `.msg-username` - so a new avatar only ever showed up after a reload.
// Matching on the data-author attribute instead of the rendered text also
// survives a local nickname, which rewrites that text entirely.
function refreshRenderedAuthor(rawUsername, avatar) {
  if (!messagesContainer || !rawUsername) return;
  const key = rawUsername.toLowerCase();
  messagesContainer.querySelectorAll(`.msg-item[data-author="${CSS.escape(key)}"]`).forEach(item => {
    const avatarBox = item.querySelector('.msg-avatar-small');
    if (avatarBox) {
      if (avatar) {
        avatarBox.innerHTML = `<img src="${safeImgSrc(avatar)}" alt="" />`;
      } else {
        avatarBox.textContent = rawUsername.charAt(0).toUpperCase();
      }
    }
    const nameEl = item.querySelector('.msg-username');
    if (nameEl) nameEl.innerHTML = getFormattedDisplayName(rawUsername);
  });
}

// Hard ceiling on rendered messages. Without it a long-lived session keeps
// growing the DOM (each item carries 6+ listeners and possibly a base64 image),
// which steadily slows every scroll and every subsequent append. Older
// messages remain in messageCache and are re-fetched on scroll-up.
const MAX_RENDERED_MESSAGES = 120;

// Only for a reader at (or headed to) the bottom: trimming the top while
// someone was reading up there pulled the messages out from under them.
function trimRenderedMessages() {
  if (!messagesContainer) return;
  let overflow = messagesContainer.childElementCount - MAX_RENDERED_MESSAGES;
  while (overflow > 0 && messagesContainer.firstElementChild) {
    messagesContainer.firstElementChild.remove();
    overflow--;
  }
}

// A long read up the history can leave hundreds of rows rendered; shed them
// once the reader is back at the bottom and the browser is idle.
let trimScheduled = false;
function scheduleTrimRenderedMessages() {
  if (trimScheduled || !messagesContainer || messagesContainer.childElementCount <= MAX_RENDERED_MESSAGES) return;
  trimScheduled = true;
  scheduleIdle(() => {
    trimScheduled = false;
    if (!isPinnedToBottom) return;
    trimRenderedMessages();
    stickToBottomIfPinned();
  }, 1000);
}

function removeRenderedMessage(el) {
  if (el) el.remove();
}

function clearRenderedMessages() {
  if (!messagesContainer) return;
  messagesContainer.replaceChildren();
  isPinnedToBottom = true;
  hideNewMessagesPill();
}

function renderMessages(messages) {
  if (!messagesContainer) return;
  const list = messages || [];
  // Only the tail is rendered; the rest stays in cache for scroll-up loading.
  const visible = list.length > MAX_RENDERED_MESSAGES ? list.slice(-MAX_RENDERED_MESSAGES) : list;
  const fragment = document.createDocumentFragment();
  visible.forEach(msg => {
    const item = createMessageItemElement(msg);
    if (item) fragment.appendChild(item);
  });
  messagesContainer.replaceChildren(fragment);
  applyMessageGrouping();
  scrollToBottom({ reveal: true });
}

function appendMessage(msg) {
  if (!messagesContainer) return;
  const item = createMessageItemElement(msg);
  if (!item) return;
  // Decided before the new row changes the height. Someone reading older
  // history stays where they are (with a "new messages" pill) instead of being
  // yanked back down by every message anyone sends.
  const follow = isPinnedToBottom || msg.username === username;
  // The "no messages yet" / "loading" placeholders are plain children of the
  // container, so they have to go before the first real message lands on top
  // of them.
  messagesContainer.querySelector('.chat-empty-placeholder')?.remove();
  messagesContainer.querySelector('.chat-loading-placeholder')?.remove();
  messagesContainer.appendChild(item);
  item.classList.toggle('is-grouped', shouldGroupWithPrevious(item.previousElementSibling, item));
  if (follow) {
    trimRenderedMessages();
    scrollToBottom();
  } else {
    unseenMessagesCount++;
    showNewMessagesPill();
  }
}

// Which id (of the DM's exactly two participants) isn't me - the read
// receipt cursor for THAT id is what determines my sent messages' ticks.
function getDmOtherParticipantId(roomId) {
  if (!roomId || !roomId.startsWith('dm_') || !currentUser || currentUser.id == null) return null;
  const parts = roomId.slice(3).split('_');
  const myId = String(currentUser.id);
  return parts.find(p => p !== myId) || null;
}

// Telegram-style tick: single = sent, double blue = the other participant's
// read cursor has reached this message. Only rendered for DMs, and only on
// messages I sent (nobody needs a tick on the other person's own messages).
// Always wrapped in the same .dm-tick-slot element (even for a fresh,
// not-yet-read send) so a later dm-read-updated can find and replace it by
// selector instead of needing to know in advance whether one was rendered.
function renderDmTickHtml(msg, roomId) {
  if (!roomId || !roomId.startsWith('dm_') || msg.username !== username) return '';
  const otherId = getDmOtherParticipantId(roomId);
  const otherLastRead = (otherId && dmReadState[roomId]) ? (dmReadState[roomId][otherId] || 0) : 0;
  const isRead = !!otherId && otherLastRead >= msg.id;
  const icon = isRead
    ? '<svg viewBox="0 0 24 16" width="15" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8l5 5L14 4"/><path d="M9 8l5 5L23 4"/></svg>'
    : '<svg viewBox="0 0 24 16" width="15" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 8l5 5L23 4"/></svg>';
  return `<span class="dm-tick-slot${isRead ? ' dm-tick-read' : ''}" title="${isRead ? 'Görüldü' : 'İletildi'}">${icon}</span>`;
}

// Re-renders just the tick icon on every currently-rendered message of mine
// in this room, after a dm-read-updated broadcast moves the other person's
// read cursor - avoids re-rendering the whole message list for this.
function updateDmTicksInView(roomId) {
  document.querySelectorAll('.message-item[data-msg-id]').forEach(item => {
    const cachedMsg = messageCache[roomId]?.find(m => String(m.id) === String(item.dataset.msgId));
    if (!cachedMsg) return;
    const slot = item.querySelector('.dm-tick-slot');
    if (slot) slot.outerHTML = renderDmTickHtml(cachedMsg, roomId);
  });
}

// Reactions are always rendered fresh from msg.reactions ({emoji: [usernames]})
// rather than patched incrementally, so a live update (reaction-updated) can
// just re-render this one small container instead of touching the whole
// message item.
function renderReactionsBarHtml(msg) {
  const reactions = msg.reactions || {};
  const emojis = ALLOWED_REACTIONS.filter(e => reactions[e] && reactions[e].length > 0);
  if (emojis.length === 0) return '<div class="msg-reactions"></div>';
  const pills = emojis.map(emoji => {
    const reactors = reactions[emoji];
    const mine = reactors.includes(username);
    const titleNames = reactors.map(u => escapeHtml(u)).join(', ');
    return `<button class="reaction-pill${mine ? ' mine' : ''}" data-emoji="${emoji}" title="${titleNames}">${emoji}<span class="reaction-count">${reactors.length}</span></button>`;
  }).join('');
  return `<div class="msg-reactions">${pills}</div>`;
}

let reactionPickerTargetMsgId = null;

function openReactionPicker(triggerBtn) {
  const popup = document.getElementById('reaction-picker-popup');
  const msgItem = triggerBtn.closest('.message-item[data-msg-id]');
  if (!popup || !msgItem) return;
  reactionPickerTargetMsgId = msgItem.dataset.msgId;

  popup.classList.remove('hidden');
  const rect = triggerBtn.getBoundingClientRect();
  const menuW = popup.offsetWidth || 190;
  const menuH = popup.offsetHeight || 90;
  let x = rect.right - menuW;
  let y = rect.top - menuH - 6;
  if (y < 8) y = rect.bottom + 6;
  if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 8;
  if (x < 8) x = 8;
  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;
}

function closeReactionPicker() {
  document.getElementById('reaction-picker-popup')?.classList.add('hidden');
  reactionPickerTargetMsgId = null;
}

// Largest box a message image is drawn in - keep in sync with .msg-image-thumb
// in style.css.
const MSG_IMAGE_MAX_W = 380;
const MSG_IMAGE_MAX_H = 300;

// Reads an embedded image's pixel size straight from its header bytes (PNG,
// GIF, JPEG, WebP) so its box can be reserved before it decodes. Otherwise
// every image grows from 0px as it loads and shoves the whole list around.
function getDataUrlImageSize(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.slice(0, comma).includes(';base64')) return null;
  let bytes;
  try {
    // JPEG headers (the only format needing a scan) sit well inside this.
    const b64 = dataUrl.slice(comma + 1, comma + 1 + 65536);
    const bin = atob(b64.slice(0, b64.length - (b64.length % 4)));
    bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  } catch (e) {
    return null;
  }
  const size = (width, height) => (width > 0 && height > 0 ? { width, height } : null);
  const u16be = (o) => (bytes[o] << 8) | bytes[o + 1];
  const u32be = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return size(u32be(16), u32be(20)); // PNG: IHDR is always the first chunk
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return size(bytes[6] | (bytes[7] << 8), bytes[8] | (bytes[9] << 8)); // GIF
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // JPEG: walk the segments up to the first start-of-frame marker.
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff || bytes[o + 1] === 0xff) { o++; continue; }
      const marker = bytes[o + 1];
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { o += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return size(u16be(o + 7), u16be(o + 5));
      }
      o += 2 + u16be(o + 2);
    }
    return null;
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]); // WebP
    if (chunk === 'VP8X') return size(1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)));
    if (chunk === 'VP8 ') return size((bytes[26] | (bytes[27] << 8)) & 0x3fff, (bytes[28] | (bytes[29] << 8)) & 0x3fff);
    if (chunk === 'VP8L') {
      const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
      return size((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
  }
  return null;
}

function messageImageSizeStyle(imageData) {
  const size = getDataUrlImageSize(imageData);
  if (!size) return '';
  const scale = Math.min(1, MSG_IMAGE_MAX_W / size.width, MSG_IMAGE_MAX_H / size.height);
  const width = Math.max(1, Math.round(size.width * scale));
  return ` style="width:${width}px;max-width:100%;height:auto;aspect-ratio:${size.width} / ${size.height}"`;
}

function createMessageItemElement(msg) {
  if (!messagesContainer) return;

  const item = document.createElement('div');
  item.className = 'msg-item message-item';
  item.dataset.msgId = msg.id;
  // Author + parsed timestamp drive both the grouping decision in
  // applyMessageGrouping() and every "update this person's messages" lookup,
  // neither of which can rely on the rendered text (a local nickname rewrites
  // the name, and the clock string has no date in it).
  item.dataset.author = (msg.username || '').toLowerCase();
  const parsedTime = parseMessageTime(msg.timestamp);
  item.dataset.ts = parsedTime ? String(parsedTime.getTime()) : '';
  // A reply or an image needs its own header to be readable, so it always
  // opens a new block instead of merging into the message above it.
  if (msg.reply_to || msg.image_data) item.dataset.startsBlock = '1';

  const avatarText = (msg.username || 'U').charAt(0).toUpperCase();
  const timeStr = formatMessageTime(msg.timestamp);

  const isOwner = msg.username === username;
  const isAdmin = currentUser && currentUser.role === 'admin';
  const hasImageOrGif = !!msg.image_data;

  // Edit button is NOT rendered if the message is an image or GIF
  let editBtnHtml = (isOwner && !hasImageOrGif) ? `
    <button class="msg-action-btn btn-edit-msg" title="Mesajı Düzenle">
      <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>
  ` : '';

  let deleteBtnHtml = (isOwner || isAdmin) ? `
    <button class="msg-action-btn danger btn-delete-msg" title="${isAdmin && !isOwner ? 'Admin: Mesajı Sil' : 'Mesajı Sil'}">
      <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
    </button>
  ` : '';

  const actionsHtml = `
    <div class="msg-actions">
      <button class="msg-action-btn btn-react-msg" title="Tepki Ekle">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
      </button>
      <button class="msg-action-btn btn-reply-msg" title="Cevapla">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
      </button>
      ${editBtnHtml}
      ${deleteBtnHtml}
    </div>
  `;

  let replyQuoteHtml = '';
  if (msg.reply_to) {
    try {
      const replyData = typeof msg.reply_to === 'string' ? JSON.parse(msg.reply_to) : msg.reply_to;
      if (replyData && replyData.username) {
        const isDeleted = replyData.is_deleted || replyData.content === 'Bu mesaj silindi';
        const quoteContent = isDeleted ? '<i>Bu mesaj silindi</i>' : escapeHtml(replyData.content || '[Görsel]');
        replyQuoteHtml = `
          <div class="msg-reply-quote ${isDeleted ? 'quote-deleted' : ''}" data-target-msg-id="${escapeHtml(String(replyData.id ?? ""))}" title="${isDeleted ? 'Bu mesaj silindi' : 'Orijinal mesaja git'}">
            <span class="reply-quote-icon">↩</span>
            <span class="reply-quote-user">@${escapeHtml(replyData.username)}</span>
            <span class="reply-quote-text">${quoteContent}</span>
          </div>
        `;
      }
    } catch (e) {}
  }

  let imageHtml = '';
  if (msg.image_data) {
    imageHtml = `
      <div class="msg-image-wrapper" title="Büyütmek için tıklayın">
        <img class="msg-image-thumb" src="${safeImgSrc(msg.image_data)}" alt="Görsel" decoding="async" loading="lazy"${messageImageSizeStyle(msg.image_data)} />
      </div>
    `;
  }

  const msgAvatarHtml = msg.avatar
    ? `<img src="${safeImgSrc(msg.avatar)}" alt="" />`
    : ((msg.username === username && userAvatar)
        ? `<img src="${safeImgSrc(userAvatar)}" alt="" />`
        : avatarText);

  // Avatar sits in its own fixed-width gutter rather than inline with the
  // name, so the text of a multi-line message stays aligned under the name
  // instead of running back out to the far left edge, and so a grouped
  // continuation line can simply reuse that gutter for its hover timestamp.
  item.innerHTML = `
    <div class="msg-gutter">
      <div class="msg-avatar-small">${msgAvatarHtml}</div>
      <span class="msg-gutter-time" aria-hidden="true">${timeStr}</span>
    </div>
    <div class="msg-content-column">
      ${replyQuoteHtml}
      <div class="msg-header">
        <span class="msg-username">${getFormattedDisplayName(msg.username)}</span>
        ${isAiBot(msg.username) ? '<span class="bot-tag">BOT</span>' : ''}
        <span class="msg-timestamp">${timeStr}</span>
        ${renderDmTickHtml(msg, msg.room_id || currentTextRoom)}
      </div>
      ${msg.content ? `<div class="msg-text">${renderMessageContent(msg.content)}</div>` : ''}
      ${imageHtml}
      ${renderReactionsBarHtml(msg)}
    </div>
    ${actionsHtml}
  `;

  // Attach reply quote click handler
  const quoteElem = item.querySelector('.msg-reply-quote');
  quoteElem?.addEventListener('click', () => {
    scrollToMessageAndHighlight(quoteElem.dataset.targetMsgId);
  });

  // Left-click for mini-profile popover, right-click for context menu on message avatar & username
  const avatarElem = item.querySelector('.msg-avatar-small');
  const unameElem = item.querySelector('.msg-username');

  const onUserClick = (e) => {
    e.stopPropagation();
    showUserProfilePopover(msg.username, e);
  };

  const onUserContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openUserContextMenu(null, msg.username, e.clientX, e.clientY, false);
  };

  if (avatarElem) {
    avatarElem.style.cursor = 'pointer';
    avatarElem.addEventListener('click', onUserClick);
    avatarElem.addEventListener('contextmenu', onUserContextMenu);
  }
  if (unameElem) {
    unameElem.style.cursor = 'pointer';
    unameElem.addEventListener('click', onUserClick);
    unameElem.addEventListener('contextmenu', onUserContextMenu);
  }

  const replyBtn = item.querySelector('.btn-reply-msg');
  replyBtn?.addEventListener('click', () => {
    startReply(msg);
  });

  const imgElem = item.querySelector('.msg-image-thumb');
  if (imgElem) {
    imgElem.addEventListener('click', () => {
      if (lightboxFullImg && imageLightboxModal) {
        lightboxFullImg.src = msg.image_data;
        imageLightboxModal.classList.remove('hidden');
      }
    });
  }

  const editBtn = item.querySelector('.btn-edit-msg');
  const deleteBtn = item.querySelector('.btn-delete-msg');

  editBtn?.addEventListener('click', () => {
    targetMessageForEdit = msg;
    const inputEditMsg = document.getElementById('input-edit-msg');
    const editMessageModal = document.getElementById('edit-message-modal');
    if (inputEditMsg && editMessageModal) {
      inputEditMsg.value = msg.content || '';
      editMessageModal.classList.remove('hidden');
      inputEditMsg.focus();
    }
  });

  deleteBtn?.addEventListener('click', () => {
    targetMessageForDelete = msg;
    confirmActionType = 'delete-message';
    const confirmModalTitle = document.getElementById('confirm-modal-title');
    const confirmModalText = document.getElementById('confirm-modal-text');
    const btnAcceptConfirm = document.getElementById('btn-accept-confirm');
    const confirmModal = document.getElementById('confirm-modal');

    if (confirmModalTitle && confirmModalText && btnAcceptConfirm && confirmModal) {
      confirmModalTitle.textContent = 'Mesajı Sil';
      confirmModalText.textContent = (isAdmin && !isOwner)
        ? `[Admin Yetkisi] "${msg.username}" adlı kullanıcının mesajını silmek istediğinizden emin misiniz?`
        : 'Bu mesajı silmek istediğinizden emin misiniz?';
      btnAcceptConfirm.textContent = 'Evet, Sil';
      confirmModal.classList.remove('hidden');
    }
  });

  return item;
}

// A single timer sweeps expired typers; it stops itself once nobody is typing.
let typingExpiryTimer = null;

function startTypingExpiryTimer() {
  if (typingExpiryTimer !== null) return;
  typingExpiryTimer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const name of Object.keys(typingUsers)) {
      if (now - typingUsers[name] >= 3000) {
        delete typingUsers[name];
        changed = true;
      }
    }
    if (changed) updateTypingIndicator();
    if (Object.keys(typingUsers).length === 0) {
      clearInterval(typingExpiryTimer);
      typingExpiryTimer = null;
    }
  }, 1000);
}

function updateTypingIndicator() {
  const now = Date.now();
  const activeTypers = Object.entries(typingUsers)
    .filter(([, ts]) => now - ts < 3000)
    .map(([name]) => name)
    .filter(name => name !== username);

  if (activeTypers.length === 0) {
    if (typingIndicator) typingIndicator.classList.add('hidden');
    return;
  }

  if (typingIndicator) typingIndicator.classList.remove('hidden');
  if (typingText) {
    if (activeTypers.length === 1) {
      typingText.textContent = `${activeTypers[0]} yazıyor...`;
    } else if (activeTypers.length === 2) {
      typingText.textContent = `${activeTypers[0]} ve ${activeTypers[1]} yazıyor...`;
    } else {
      typingText.textContent = `${activeTypers.length} kişi yazıyor...`;
    }
  }
}

let onlineUsersRenderRAF = null;
let lastOnlineUsersSignature = null;

// Coalesce bursts (a reconnect storm fires one broadcast per socket) into one
// paint, and skip the paint entirely when nothing visible actually changed.
function scheduleOnlineUsersRender(data) {
  lastOnlineData = data;
  if (onlineUsersRenderRAF !== null) return;
  onlineUsersRenderRAF = requestAnimationFrame(() => {
    onlineUsersRenderRAF = null;
    renderOnlineUsers(lastOnlineData);
  });
}

// Custom status ("durum mesaji") rides along on the roster (allUsers), not on
// the lighter online-presence payload, so fall back to the cached roster row
// when the presence entry does not carry one.
function getUserStatusText(user) {
  if (!user) return '';
  const direct = typeof user.status === 'string' ? user.status.trim() : '';
  if (direct) return direct;
  const cached = allUsersCache.find(u => (u.username || '').toLowerCase() === (user.username || '').toLowerCase());
  return ((cached && cached.status) || '').trim();
}

function buildMemberRowHtml(user, isFriend, dotClass) {
  const initial = (user.username || 'U').charAt(0).toUpperCase();
  const avatarHtml = user.avatar
    ? `<img src="${safeImgSrc(user.avatar)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
    : initial;
  const statusText = getUserStatusText(user);

  return `
    <div class="member-avatar">${avatarHtml}<span class="member-status-dot${dotClass}"></span></div>
    <div class="member-text">
      <span class="member-name">${getFormattedDisplayName(user.username)} ${isFriend ? '<span class="chestnut-badge" title="Arkadaşınız">🌰</span>' : ''}</span>
      ${statusText ? `<span class="member-status-text" title="${escapeHtml(statusText)}">${escapeHtml(statusText)}</span>` : ''}
    </div>
  `;
}

function renderOnlineUsers(data) {
  if (!onlineUsersList) return;
  if (onlineUsersRenderRAF !== null) {
    cancelAnimationFrame(onlineUsersRenderRAF);
    onlineUsersRenderRAF = null;
  }
  lastOnlineData = data;

  let onlineUsers = [];
  let allUsers = [];

  if (Array.isArray(data)) {
    onlineUsers = data;
  } else if (data && typeof data === 'object') {
    onlineUsers = data.onlineUsers || [];
    // The server only ships the full roster when it actually changed, so fall
    // back to the copy we already hold instead of blanking the offline list.
    allUsers = Array.isArray(data.allUsers) ? data.allUsers : allUsersCache;
  }

  // Update allUsersCache so newly registered/connected users can immediately be mentioned
  if (Array.isArray(allUsers) && allUsers.length > 0 && allUsers !== allUsersCache) {
    allUsersCache = allUsers;
    mentionRenderRegexCache = null;
  }
  if (Array.isArray(onlineUsers)) {
    onlineUsers.forEach(ou => {
      if (ou.username && !allUsersCache.some(u => (u.username || '').toLowerCase() === ou.username.toLowerCase())) {
        allUsersCache.push({ id: ou.userId || ou.socketId, username: ou.username, avatar: ou.avatar || null });
        mentionRenderRegexCache = null;
      }
    });
  }

  // Deduplicate online users by lowercase username
  const seenOnline = new Set();
  const uniqueOnlineUsers = [];
  onlineUsers.forEach(u => {
    const lname = (u.username || '').toLowerCase();
    if (lname && !seenOnline.has(lname)) {
      seenOnline.add(lname);
      uniqueOnlineUsers.push(u);
    }
  });

  onlineUsernamesSet = seenOnline;

  // Away users (backgrounded/tray-hidden past AWAY_TIMEOUT_MS) sort to the
  // bottom of the online list; Array#sort is stable, so relative order is
  // otherwise untouched.
  uniqueOnlineUsers.sort((a, b) => (a.away ? 1 : 0) - (b.away ? 1 : 0));

  const offlineUsers = (Array.isArray(allUsers) ? allUsers : []).filter(u => {
    const lname = (u.username || '').toLowerCase();
    return lname && !onlineUsernamesSet.has(lname) && !isAiBot(lname);
  });

  // Skip the rebuild (and the listener churn that comes with it) when the
  // visible result would be byte-for-byte identical.
  const signature = [
    uniqueOnlineUsers.map(u => `${u.username}|${avatarFingerprint(u.avatar)}|${u.socketId}|${u.away ? 1 : 0}|${getUserStatusText(u)}`).join(','),
    offlineUsers.map(u => `${u.username}|${avatarFingerprint(u.avatar)}|${getUserStatusText(u)}`).join(','),
    JSON.stringify(mutedUsers),
    JSON.stringify(userNicknames),
    [...myFriendsSet].join(',')
  ].join('§');
  if (signature === lastOnlineUsersSignature) return;
  lastOnlineUsersSignature = signature;

  if (onlineCountBadge) onlineCountBadge.textContent = uniqueOnlineUsers.length;

  const onlineFragment = document.createDocumentFragment();
  uniqueOnlineUsers.forEach(user => {
    const isMuted = !!mutedUsers[(user.username || '').toLowerCase()];
    const isFriend = myFriendsSet.has((user.username || '').toLowerCase());
    const item = document.createElement('div');
    item.className = `member-item${isMuted ? ' muted-user-item' : ''}`;
    item.innerHTML = buildMemberRowHtml(user, isFriend, user.away ? ' away' : '');

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      showUserProfilePopover(user, e);
    });

    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openUserContextMenu(user.socketId || null, user.username, e.clientX, e.clientY, false);
    });

    onlineFragment.appendChild(item);
  });
  onlineUsersList.replaceChildren(onlineFragment);

  // Render offline users section
  if (offlineUsersList) {
    const offlineFragment = document.createDocumentFragment();

    if (offlineCountBadge) offlineCountBadge.textContent = offlineUsers.length;

    offlineUsers.forEach(user => {
      const isMuted = !!mutedUsers[(user.username || '').toLowerCase()];
      const isFriend = myFriendsSet.has((user.username || '').toLowerCase());
      const item = document.createElement('div');
      item.className = `member-item offline${isMuted ? ' muted-user-item' : ''}`;
      item.innerHTML = buildMemberRowHtml(user, isFriend, ' offline');

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        showUserProfilePopover(user, e);
      });

      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openUserContextMenu(user.id || null, user.username, e.clientX, e.clientY, false);
      });

      offlineFragment.appendChild(item);
    });
    offlineUsersList.replaceChildren(offlineFragment);
  }

  // Keep the friends dashboard's online/offline status live instead of only
  // refreshing when the user leaves and re-enters the Friends view.
  if (currentMainView === 'friends') {
    renderFriendsDMList();
    renderFriendsRightPanel();
  }
}

// ===== Responsive navigation ===============================================
// Below 900px the sidebar and members panel are overlay drawers (see the
// "Responsive system" section in style.css). The CSS owns the animation; this
// only manages which body class is set, plus the usual dismissal affordances.
const COMPACT_LAYOUT_QUERY = '(max-width: 900px)';

function isCompactLayout() {
  return window.matchMedia(COMPACT_LAYOUT_QUERY).matches;
}

function setDrawer(which, open) {
  const body = document.body;
  if (which === 'sidebar') {
    body.classList.toggle('sidebar-open', open);
    if (open) body.classList.remove('members-open');
  } else if (which === 'members') {
    body.classList.toggle('members-open', open);
    if (open) body.classList.remove('sidebar-open');
  }
  const anyOpen = body.classList.contains('sidebar-open') || body.classList.contains('members-open');
  body.classList.toggle('drawer-open', anyOpen);

  const toggle = document.getElementById('mobile-nav-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', String(body.classList.contains('sidebar-open')));
}

function closeAllDrawers() {
  document.body.classList.remove('sidebar-open', 'members-open', 'drawer-open');
  const toggle = document.getElementById('mobile-nav-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

function initMobileNavigation() {
  const toggle = document.getElementById('mobile-nav-toggle');
  const scrim = document.getElementById('mobile-scrim');
  const sidebar = document.querySelector('.sidebar');

  toggle?.addEventListener('click', () => {
    setDrawer('sidebar', !document.body.classList.contains('sidebar-open'));
  });

  scrim?.addEventListener('click', closeAllDrawers);

  // Picking a channel or a friend should get the drawer out of the way.
  sidebar?.addEventListener('click', (e) => {
    if (!isCompactLayout()) return;
    if (e.target.closest('.channel-item, .friends-nav-btn, .friends-dm-item, .sidebar-voice-user')) {
      closeAllDrawers();
    }
  });

  onlineUsersPanel?.addEventListener('click', (e) => {
    if (isCompactLayout() && e.target.closest('.member-item')) closeAllDrawers();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllDrawers();
  });

  // Leaving the compact breakpoint must not strand a drawer class behind.
  const mq = window.matchMedia(COMPACT_LAYOUT_QUERY);
  const onBreakpointChange = (ev) => {
    if (!ev.matches) closeAllDrawers();
  };
  if (mq.addEventListener) mq.addEventListener('change', onBreakpointChange);
  else if (mq.addListener) mq.addListener(onBreakpointChange);
}

function initSidebarResizers() {
  const sidebar = document.querySelector('.sidebar');
  const membersPanel = document.getElementById('online-users-panel');
  const resizerLeft = document.getElementById('resizer-left');
  const resizerRight = document.getElementById('resizer-right');

  if (resizerLeft && sidebar) {
    let isResizingLeft = false;

    resizerLeft.addEventListener('mousedown', (e) => {
      if (isCompactLayout()) return; // the sidebar is a drawer here, not a column
      e.preventDefault();
      isResizingLeft = true;
      resizerLeft.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizingLeft) return;
      const newWidth = Math.max(180, Math.min(500, e.clientX));
      sidebar.style.width = `${newWidth}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isResizingLeft) {
        isResizingLeft = false;
        resizerLeft.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }

  if (resizerRight && membersPanel) {
    let isResizingRight = false;

    resizerRight.addEventListener('mousedown', (e) => {
      if (isCompactLayout()) return; // the members panel is a drawer here
      e.preventDefault();
      isResizingRight = true;
      resizerRight.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizingRight) return;
      const newWidth = Math.max(180, Math.min(500, window.innerWidth - e.clientX));
      membersPanel.style.width = `${newWidth}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isResizingRight) {
        isResizingRight = false;
        resizerRight.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Avatars, banners and chat images all come from other users and end up in
// <img src="..."> inside innerHTML templates. Only image data URLs, http(s)
// URLs and same-origin paths are let through, and the result is attribute-
// escaped, so a crafted value (e.g. `x" onerror="...`) can't break out of the
// attribute and run script. The server validates these fields as well; this
// also covers values stored before it did.
const SAFE_IMG_SRC_RE = /^(?:data:image\/(?:png|jpe?g|gif|webp);base64,|https?:\/\/|blob:|\/(?!\/))/i;
function safeImgSrc(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!SAFE_IMG_SRC_RE.test(trimmed)) return '';
  return escapeHtml(trimmed);
}

// Same idea for CSS url(...) values set through element.style.
function cssImageUrl(url) {
  if (typeof url !== 'string' || !SAFE_IMG_SRC_RE.test(url.trim())) return 'none';
  return `url("${url.trim().replace(/["\\\n\r]/g, '\\$&')}")`;
}

// Compiling this regex from the entire user roster once per rendered message
// meant 50 compilations just to open a channel. It is now built once and
// invalidated whenever the roster changes.
let mentionRenderRegexCache = null;

function getMentionRenderRegex() {
  if (mentionRenderRegexCache) return mentionRenderRegexCache;
  const knownUsernames = (allUsersCache || []).map(u => u.username).filter(Boolean);
  const names = Array.from(new Set(['all', 'everyone', ...knownUsernames])).sort((a, b) => b.length - a.length);
  const escapedPatterns = names.map(n => escapeHtml(n).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'));
  mentionRenderRegexCache = new RegExp(
    `@(?:(${escapedPatterns.join('|')})|([A-Za-z0-9_\\.\\-ğĞıİöÖçÇüÜŞş]+))`,
    'gi'
  );
  return mentionRenderRegexCache;
}

function renderMessageContent(content) {
  if (!content) return '';
  const escaped = escapeHtml(content);
  if (!escaped.includes('@')) return escaped;

  const regex = getMentionRenderRegex();
  regex.lastIndex = 0;

  return escaped.replace(regex, (fullMatch, exactName, fallbackToken) => {
    const token = exactName || fallbackToken;
    const tokenLower = token.toLowerCase();
    if (tokenLower === 'all' || tokenLower === 'everyone') {
      return `<span class="mention mention-all">@${token}</span>`;
    }
    const isMe = tokenLower === (username || '').toLowerCase();
    return `<span class="mention ${isMe ? 'mention-me' : ''}">@${token}</span>`;
  });
}


// --- NEW FRIENDS SYSTEM (3-COLUMN LAYOUT) ---
let myFriendsList = [];
let myFriendsSet = new Set();
let friendRequests = { incoming: [], outgoing: [] };
let currentMainView = 'server'; // 'server' or 'friends'

// So the top-left "Arkadaşlar" nav button shows a badge for unseen DMs even
// while the user is off in a text channel and never opened the dashboard.
//
// Only counts rooms the current user is actually a participant in. Before the
// DM-privacy fix, `new-message` was a global broadcast and any online user
// could end up with an unreadCounts['dm_x_y'] entry for a DM between two
// OTHER people. Those entries have no friends-list row to click (you were
// never a participant), so without this guard they'd inflate the badge
// forever with no way to clear them - exactly the "stuck notification" bug.
function getDmUnreadTotal() {
  const myId = currentUser && currentUser.id != null ? String(currentUser.id) : null;
  // Can't verify participation without a resolved user (e.g. the brief
  // window before verifySession() completes) - fail closed rather than
  // counting everything, matching pruneOrphanedUnreadCounts()'s behavior.
  if (!myId) return 0;
  let total = 0;
  for (const key in unreadCounts) {
    if (!key.startsWith('dm_')) continue;
    if (!key.slice(3).split('_').includes(myId)) continue;
    total += (unreadCounts[key] || 0);
  }
  return total;
}

// Actually removes those orphaned entries from storage (the guard above just
// stops them being counted). Safe to call repeatedly - cheap, and a no-op
// once storage is clean. Needs currentUser to be resolved, so it's called
// from updateFriendsData() rather than at initial load time.
function pruneOrphanedUnreadCounts() {
  const myId = currentUser && currentUser.id != null ? String(currentUser.id) : null;
  if (!myId) return;
  let changed = false;
  for (const key in unreadCounts) {
    if (!key.startsWith('dm_')) continue;
    if (!key.slice(3).split('_').includes(myId)) {
      delete unreadCounts[key];
      changed = true;
    }
  }
  if (changed) {
    saveUnreadStateToStorage();
    scheduleChannelListRender();
  }
}

function getFriendsTabBadgeCount() {
  return (friendRequests.incoming || []).length + getDmUnreadTotal();
}

// Patches the badge in place - use this when only the count changed and the
// button's innerHTML doesn't need a full rebuild (switchMainView() handles
// the full rebuild case itself when the view/label actually changes).
function updateFriendsTabBadge() {
  const badge = document.getElementById('friends-badge');
  if (!badge) return;
  const count = getFriendsTabBadgeCount();
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.classList.toggle('hidden', count === 0);
}

function switchMainView(view, sidebarModeOverride) {
  currentMainView = view;
  const chatAreaWrapper = document.getElementById('chat-area-wrapper');
  const friendsDashView = document.getElementById('friends-dashboard-view');
  const btnFriendsTab = document.getElementById('btn-friends-tab');
  const badgeCount = getFriendsTabBadgeCount();
  const badgeHtml = `<span id="friends-badge" class="friends-badge-count ${badgeCount > 0 ? '' : 'hidden'}">${badgeCount > 99 ? '99+' : badgeCount}</span>`;

  const resizerRight = document.getElementById('resizer-right');
  const sidebarTextGroup = document.getElementById('sidebar-text-group');
  const sidebarVoiceGroup = document.getElementById('sidebar-voice-group');
  const sidebarRecentDmsGroup = document.getElementById('sidebar-recent-dms-group');

  // Which list the sidebar shows (server channels vs recent DMs) is normally
  // tied to the main view, but opening a DM keeps you browsing "friends land"
  // in the sidebar even though the chat pane now shows a real room - so
  // callers that open a DM pass 'dms' explicitly to override the default.
  const sidebarMode = sidebarModeOverride || (view === 'friends' ? 'dms' : 'channels');
  if (sidebarTextGroup) sidebarTextGroup.classList.toggle('hidden', sidebarMode === 'dms');
  if (sidebarVoiceGroup) sidebarVoiceGroup.classList.toggle('hidden', sidebarMode === 'dms');
  if (sidebarRecentDmsGroup) sidebarRecentDmsGroup.classList.toggle('hidden', sidebarMode !== 'dms');

  if (view === 'friends') {
    if (chatAreaWrapper) chatAreaWrapper.classList.add('hidden');
    if (friendsDashView) friendsDashView.classList.remove('hidden');
    // The server member list panel has no meaning outside a chat channel,
    // and competes for space with the dashboard's own right-hand panel.
    if (onlineUsersPanel) onlineUsersPanel.classList.add('hidden');
    if (resizerRight) resizerRight.classList.add('hidden');
    if (socket) socket.emit('get-friends-data');
    renderFriendsAllPanels();
  } else {
    if (friendsDashView) friendsDashView.classList.add('hidden');
    if (chatAreaWrapper) chatAreaWrapper.classList.remove('hidden');
    if (onlineUsersPanel) onlineUsersPanel.classList.toggle('hidden', !membersVisible);
    if (resizerRight) resizerRight.classList.remove('hidden');
  }

  // The top nav button reads "Sunucuya Dön" whenever the sidebar is showing
  // the recent-DMs list - not only when the friends dashboard itself is
  // visible. Opening a DM keeps view:'server' but forces sidebarMode:'dms'
  // (see the comment above), so without this the button would still say
  // "Arkadaşlar" while already deep in a DM conversation, with no direct way
  // back to the server short of opening the dashboard first.
  if (btnFriendsTab) {
    if (sidebarMode === 'dms') {
      btnFriendsTab.classList.add('active');
      btnFriendsTab.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        <span>Sunucuya Dön</span>
        ${badgeHtml}
      `;
    } else {
      btnFriendsTab.classList.remove('active');
      btnFriendsTab.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        <span>Arkadaşlar</span>
        ${badgeHtml}
      `;
    }
  }
}

// Takes the user straight from wherever "friends land" (dashboard or an open
// DM) back to the server's topmost text channel - lastFetchedRooms is
// already ordered the same way the sidebar renders it, so its first 'text'
// entry is exactly "whichever text channel is on top" right now.
function goToTopTextChannel() {
  if (callViewOpen) closeCallView();
  switchMainView('server');
  const topTextRoom = (lastFetchedRooms || []).find(r => r.type === 'text');
  if (topTextRoom) {
    joinTextRoom(topTextRoom.id, topTextRoom.name);
  }
}

function updateFriendsData(friends, requests) {
  if (Array.isArray(friends)) {
    myFriendsList = friends;
    myFriendsSet = new Set(friends.map(f => (f.username || '').toLowerCase()));
  }
  if (requests) {
    friendRequests = requests;
  }

  pruneOrphanedUnreadCounts();

  const incomingCount = (friendRequests.incoming || []).length;
  const friendsPendingCount = document.getElementById('friends-pending-count');

  updateFriendsTabBadge();
  if (friendsPendingCount) {
    friendsPendingCount.textContent = incomingCount;
    friendsPendingCount.classList.toggle('hidden', incomingCount === 0);
  }

  if (lastOnlineData) renderOnlineUsers(lastOnlineData);
  scheduleChannelListRender();

  // Always re-render friends panels if dashboard is visible
  if (currentMainView === 'friends') {
    renderFriendsAllPanels();
  }
}

// Main orchestrator: renders all three panels
function renderFriendsAllPanels() {
  renderFriendsDMList();
  renderFriendsPendingPane();
  renderFriendsRightPanel();
}

// ===== SIDEBAR: Recent DMs (shown in place of channel groups while in Friends view) =====
function renderFriendsDMList() {
  const container = document.getElementById('sidebar-recent-dms-list');
  if (!container) return;

  if (myFriendsList.length === 0) {
    container.innerHTML = '<div class="friends-dm-empty">Arkadaşınız bulunmuyor.</div>';
    return;
  }

  const sorted = [...myFriendsList].sort((a, b) => {
    const aOn = onlineUsernamesSet.has((a.username || '').toLowerCase()) ? 0 : 1;
    const bOn = onlineUsernamesSet.has((b.username || '').toLowerCase()) ? 0 : 1;
    if (aOn !== bOn) return aOn - bOn;
    return (a.username || '').localeCompare(b.username || '');
  });

  container.innerHTML = sorted.map(f => {
    const isOnline = onlineUsernamesSet.has((f.username || '').toLowerCase());
    const initial = (f.username || 'U').charAt(0).toUpperCase();
    const avatarContent = f.avatar ? `<img src="${safeImgSrc(f.avatar)}" alt="" />` : initial;
    const onlineDot = isOnline ? '<span class="friends-dm-online-dot"></span>' : '';
    const dmRoomId = `dm_${Math.min(currentUser ? currentUser.id : 0, f.id)}_${Math.max(currentUser ? currentUser.id : 0, f.id)}`;
    const isActiveDm = currentTextRoom === dmRoomId;
    const unread = unreadCounts[dmRoomId] || 0;
    const unreadBadgeHtml = unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : '';
    return `
      <div class="friends-dm-item${isActiveDm ? ' active' : ''}" data-dm-friend-id="${f.id}" data-dm-friend-username="${escapeHtml(f.username)}">
        <div class="friends-dm-avatar">${avatarContent}${onlineDot}</div>
        <div class="friends-dm-info">
          <div class="friends-dm-name">${getFormattedDisplayName(f.username)}</div>
          <div class="friends-dm-status" style="color:${isOnline ? '#23a55a' : '#94a3b8'};">${isOnline ? '● Çevrimiçi' : '● Çevrimdışı'}</div>
        </div>
        ${unreadBadgeHtml}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.friends-dm-item[data-dm-friend-id]').forEach(item => {
    item.onclick = () => {
      const targetUserId = Number(item.dataset.dmFriendId);
      if (targetUserId && socket) {
        socket.emit('get-or-create-dm', { targetUserId });
        switchMainView('server', 'dms');
      }
    };
    item.oncontextmenu = (e) => {
      e.preventDefault();
      openUserContextMenu(null, item.dataset.dmFriendUsername, e.clientX, e.clientY, false);
    };
  });
}

// ===== CENTER PANEL: Pending requests tab =====
function renderFriendsPendingPane() {
  const listIncoming = document.getElementById('friends-dash-list-incoming');
  const listOutgoing = document.getElementById('friends-dash-list-outgoing');

  if (listIncoming) {
    const incoming = friendRequests.incoming || [];
    if (incoming.length === 0) {
      listIncoming.innerHTML = '<div class="friends-empty-state" style="padding:24px;">Gelen arkadaşlık isteği yok.</div>';
    } else {
      listIncoming.innerHTML = incoming.map(req => {
        const initial = (req.sender_username || 'U').charAt(0).toUpperCase();
        const avatarHtml = req.sender_avatar ? `<img src="${safeImgSrc(req.sender_avatar)}" alt="" />` : initial;
        return `
          <div class="friend-item-row">
            <div class="friend-item-user">
              <div class="friend-item-avatar">${avatarHtml}</div>
              <div class="friend-item-details">
                <span class="friend-item-name">${escapeHtml(req.sender_username)}</span>
                <span style="font-size: 11px; color: #94a3b8;">Arkadaşlık İsteği Gönderdi</span>
              </div>
            </div>
            <div class="friend-item-actions">
              <button class="btn-primary btn-accept-request" data-req-id="${req.id}" style="padding: 6px 14px; font-size: 12px; background: #23a55a; border:none; border-radius:8px;">Kabul Et</button>
              <button class="btn-secondary btn-reject-request" data-req-id="${req.id}" style="padding: 6px 14px; font-size: 12px; color: #ed4245; border-radius:8px;">Reddet</button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  if (listOutgoing) {
    const outgoing = friendRequests.outgoing || [];
    if (outgoing.length === 0) {
      listOutgoing.innerHTML = '<div class="friends-empty-state" style="padding:24px;">Giden arkadaşlık isteği yok.</div>';
    } else {
      listOutgoing.innerHTML = outgoing.map(req => {
        const initial = (req.receiver_username || 'U').charAt(0).toUpperCase();
        const avatarHtml = req.receiver_avatar ? `<img src="${safeImgSrc(req.receiver_avatar)}" alt="" />` : initial;
        return `
          <div class="friend-item-row">
            <div class="friend-item-user">
              <div class="friend-item-avatar">${avatarHtml}</div>
              <div class="friend-item-details">
                <span class="friend-item-name">${escapeHtml(req.receiver_username)}</span>
                <span style="font-size: 11px; color: #f0a732;">⌛ Kabul Bekleniyor</span>
              </div>
            </div>
            <div class="friend-item-actions">
              <button class="btn-secondary btn-reject-request" data-req-id="${req.id}" style="padding: 6px 12px; font-size: 12px; border-radius:8px;">İptal Et</button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // Wire up buttons after render
  document.querySelectorAll('.btn-accept-request').forEach(btn => {
    btn.onclick = () => {
      const reqId = Number(btn.dataset.reqId);
      if (reqId && socket) {
        socket.emit('accept-friend-request', { requestId: reqId });
      }
    };
  });

  document.querySelectorAll('.btn-reject-request').forEach(btn => {
    btn.onclick = () => {
      const reqId = Number(btn.dataset.reqId);
      if (reqId && socket) {
        socket.emit('reject-friend-request', { requestId: reqId });
      }
    };
  });
}

// ===== RIGHT PANEL: All friends, online pinned at top =====
function renderFriendsRightPanel() {
  const list = document.getElementById('friends-all-list');
  const countEl = document.getElementById('friends-right-count');
  if (countEl) countEl.textContent = myFriendsList.length;
  if (!list) return;

  if (myFriendsList.length === 0) {
    list.innerHTML = '<div class="friends-empty-state-sm">Henüz arkadaşınız bulunmuyor.</div>';
    return;
  }

  const sorted = [...myFriendsList].sort((a, b) => {
    const aOnline = onlineUsernamesSet.has((a.username || '').toLowerCase()) ? 0 : 1;
    const bOnline = onlineUsernamesSet.has((b.username || '').toLowerCase()) ? 0 : 1;
    if (aOnline !== bOnline) return aOnline - bOnline;
    return (a.username || '').localeCompare(b.username || '');
  });

  list.innerHTML = sorted.map(f => {
    const isOnline = onlineUsernamesSet.has((f.username || '').toLowerCase());
    const initial = (f.username || 'U').charAt(0).toUpperCase();
    const avatarContent = f.avatar ? `<img src="${safeImgSrc(f.avatar)}" alt="" />` : initial;
    const onlineDot = isOnline ? '<span class="friends-online-mini-dot"></span>' : '';
    return `
      <div class="friends-online-mini-card${isOnline ? '' : ' offline'}" data-target-id="${f.id}" data-username="${escapeHtml(f.username)}">
        <div class="friends-online-mini-avatar">
          ${avatarContent}
          ${onlineDot}
        </div>
        <div class="friends-online-mini-info">
          <span class="friends-online-mini-name">${getFormattedDisplayName(f.username)} <span class="chestnut-badge" title="Arkadaşınız">🌰</span></span>
          <span class="friends-online-mini-status" style="color:${isOnline ? '#23a55a' : '#94a3b8'};">${isOnline ? '● Çevrimiçi' : '● Çevrimdışı'}</span>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.friends-online-mini-card[data-target-id]').forEach(card => {
    // Right panel = browse friends -> mini profile. DMs are opened from the
    // sidebar's recent-DMs list instead (left-click there).
    card.onclick = (e) => {
      const targetId = Number(card.dataset.targetId);
      const friendObj = myFriendsList.find(fr => fr.id === targetId);
      if (friendObj) {
        showUserProfilePopover(friendObj, e);
      }
    };
    card.oncontextmenu = (e) => {
      e.preventDefault();
      openUserContextMenu(null, card.dataset.username, e.clientX, e.clientY, false);
    };
  });
}

// Legacy stubs

document.addEventListener('DOMContentLoaded', () => {
  initApp();
  initSidebarResizers();

  const btnFriendsTab = document.getElementById('btn-friends-tab');

  btnFriendsTab?.addEventListener('click', () => {
    // Ground this in what's actually on screen rather than the currentMainView
    // variable: if that ever drifts from the real DOM state, a variable-only
    // toggle would send the click the wrong way and the button would look
    // like it "does nothing" - reading the sidebar's real visibility can't
    // drift. The recent-DMs group stays visible both while the dashboard is
    // open AND while an open DM conversation forced sidebarMode:'dms', so
    // this covers "Sunucuya Dön" pressed from either place.
    const recentDmsGroup = document.getElementById('sidebar-recent-dms-group');
    const isInDmLand = recentDmsGroup && !recentDmsGroup.classList.contains('hidden');
    if (isInDmLand) {
      goToTopTextChannel();
    } else {
      switchMainView('friends');
    }
  });

  // Sits in the "Son Mesajlar" sidebar header, next to the recent-DMs list -
  // takes the user to the friends dashboard (add-friend / pending requests),
  // since the top nav button above now goes straight back to the server
  // instead (see goToTopTextChannel()) and no longer doubles as a way into
  // the dashboard while a DM is open.
  document.getElementById('btn-back-to-channels')?.addEventListener('click', () => {
    switchMainView('friends');
  });

  document.querySelectorAll('.friends-dash-tab[data-dash-tab]').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      document.querySelectorAll('.friends-dash-tab[data-dash-tab]').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.friends-dash-pane').forEach(p => p.classList.remove('active'));

      tabBtn.classList.add('active');
      const targetPane = document.getElementById(`friends-pane-${tabBtn.dataset.dashTab}`);
      if (targetPane) targetPane.classList.add('active');
    });
  });

  const dashBtnSubmitAddFriend = document.getElementById('dash-btn-submit-add-friend');
  const dashInputAddFriend = document.getElementById('dash-input-add-friend');
  const addFriendAutocompleteEl = document.getElementById('add-friend-autocomplete');

  const closeAddFriendAutocomplete = () => {
    if (addFriendAutocompleteEl) {
      addFriendAutocompleteEl.classList.add('hidden');
      addFriendAutocompleteEl.innerHTML = '';
    }
  };

  dashBtnSubmitAddFriend?.addEventListener('click', () => {
    const targetUname = dashInputAddFriend?.value.trim();
    if (!targetUname) return;

    const addStatus = document.getElementById('dash-add-friend-status');
    if (addStatus) {
      addStatus.textContent = 'İstek gönderiliyor...';
      addStatus.className = 'add-friend-status';
      addStatus.classList.remove('hidden');
    }

    closeAddFriendAutocomplete();

    if (socket) {
      socket.emit('send-friend-request', { targetUsername: targetUname });
      if (dashInputAddFriend) dashInputAddFriend.value = '';
    }
  });

  dashInputAddFriend?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      dashBtnSubmitAddFriend?.click();
    } else if (e.key === 'Escape') {
      closeAddFriendAutocomplete();
    }
  });

  dashInputAddFriend?.addEventListener('input', () => {
    renderAddFriendAutocomplete(dashInputAddFriend.value);
  });

  document.addEventListener('click', (e) => {
    if (!addFriendAutocompleteEl || addFriendAutocompleteEl.classList.contains('hidden')) return;
    if (e.target === dashInputAddFriend || addFriendAutocompleteEl.contains(e.target)) return;
    closeAddFriendAutocomplete();
  });
});

// ===== Add Friend: username search-as-you-type suggestions =====
function renderAddFriendAutocomplete(query) {
  const container = document.getElementById('add-friend-autocomplete');
  if (!container) return;

  const q = query.trim().toLowerCase();
  if (q.length < 2) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  const outgoingUsernames = new Set((friendRequests.outgoing || []).map(r => (r.receiver_username || '').toLowerCase()));
  const incomingUsernames = new Set((friendRequests.incoming || []).map(r => (r.sender_username || '').toLowerCase()));
  const selfLower = (username || '').toLowerCase();

  const results = allUsersCache
    .filter(u => {
      const uname = (u.username || '').toLowerCase();
      if (!uname || uname === selfLower) return false;
      if (isAiBot(uname)) return false;
      if (myFriendsSet.has(uname)) return false;
      if (outgoingUsernames.has(uname) || incomingUsernames.has(uname)) return false;
      return uname.includes(q);
    })
    .sort((a, b) => {
      const aOn = onlineUsernamesSet.has((a.username || '').toLowerCase()) ? 0 : 1;
      const bOn = onlineUsernamesSet.has((b.username || '').toLowerCase()) ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
      return (a.username || '').localeCompare(b.username || '');
    })
    .slice(0, 8);

  if (results.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.innerHTML = results.map(u => {
    const initial = (u.username || 'U').charAt(0).toUpperCase();
    const avatarHtml = u.avatar ? `<img src="${safeImgSrc(u.avatar)}" alt="" />` : initial;
    const isOnline = onlineUsernamesSet.has((u.username || '').toLowerCase());
    return `
      <div class="mention-item" data-username="${escapeHtml(u.username)}">
        <div class="mention-item-avatar">${avatarHtml}</div>
        <span class="mention-item-name">${getFormattedDisplayName(u.username)}</span>
        ${isOnline ? '<span class="mention-item-online-dot" title="Çevrimiçi"></span>' : ''}
        <span class="mention-item-tag">${formatUserTag(u.id)}</span>
      </div>
    `;
  }).join('');

  container.classList.remove('hidden');

  container.querySelectorAll('.mention-item[data-username]').forEach(row => {
    row.onclick = () => {
      const dashInputAddFriend = document.getElementById('dash-input-add-friend');
      if (dashInputAddFriend) {
        dashInputAddFriend.value = row.dataset.username;
        dashInputAddFriend.focus();
      }
      container.classList.add('hidden');
      container.innerHTML = '';
    };
  });
}
