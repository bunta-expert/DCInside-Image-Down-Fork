let pendingQueue = [];
let opening = false;
const pendingTabs = new Map();
let autoProcessingTabId = null;
let nextOpenTimer = null;
const DEFAULT_OPEN_DELAY_MS = 2000;
const MIN_OPEN_DELAY_MS = 500;
const MAX_OPEN_DELAY_MS = 10000;
const DEBUG_KEY = "DebugMode";
const DEBUG_PREFIX = "[DCID Downloader][BG]";
let debugEnabled = false;

chrome.storage.sync.get({ [DEBUG_KEY]: false }, data => {
	debugEnabled = Boolean(data[DEBUG_KEY]);
	if (debugEnabled) console.log(DEBUG_PREFIX, "디버그 모드 활성화");
});

chrome.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "sync" || !changes[DEBUG_KEY]) return;
	debugEnabled = Boolean(changes[DEBUG_KEY].newValue);
	console.log(DEBUG_PREFIX, `디버그 모드 ${debugEnabled ? "활성화" : "비활성화"}`);
});

function debugLog(...args) {
	if (debugEnabled) console.log(DEBUG_PREFIX, ...args);
}

function normalizeDelayMs(rawValue) {
	const numeric = Number(rawValue);
	if (!Number.isFinite(numeric)) return DEFAULT_OPEN_DELAY_MS;
	return Math.max(MIN_OPEN_DELAY_MS, Math.min(MAX_OPEN_DELAY_MS, Math.round(numeric)));
}

function queueOpenTab(url, delayMs = DEFAULT_OPEN_DELAY_MS, options = {}) {
	if (!url || typeof url !== "string") return;
	const trimmedUrl = url.trim();
	if (!trimmedUrl) return;
	pendingQueue.push({
		url: trimmedUrl,
		delayMs: normalizeDelayMs(delayMs),
		forceBody: Boolean(options.forceBody)
	});
	openNext();
}

function scheduleNextOpen(delayMs = DEFAULT_OPEN_DELAY_MS) {
	const delay = normalizeDelayMs(delayMs);
	if (nextOpenTimer) return;
	debugLog("다음 탭 오픈 예약", { delay, queue: pendingQueue.length });
	nextOpenTimer = setTimeout(() => {
		nextOpenTimer = null;
		openNext();
	}, delay);
}

function onAutoTabDone(tabId, meta) {
	pendingTabs.delete(tabId);
	if (autoProcessingTabId === tabId) {
		autoProcessingTabId = null;
		scheduleNextOpen(meta?.delayMs);
	}
}

function openNext() {
	if (opening || autoProcessingTabId || !pendingQueue.length) return;
	opening = true;
	const nextItem = pendingQueue.shift();
		debugLog("탭 오픈 큐 처리", {
			remainQueue: pendingQueue.length,
			url: nextItem.url,
			delayMs: nextItem.delayMs,
			forceBody: nextItem.forceBody
		});

	chrome.tabs.create({ url: nextItem.url, active: false }, tab => {
		opening = false;
		if (chrome.runtime.lastError || !tab?.id) {
			debugLog("탭 오픈 실패", chrome.runtime.lastError?.message || "tab id 없음");
			scheduleNextOpen(nextItem.delayMs);
			return;
		}

		autoProcessingTabId = tab.id;
		pendingTabs.set(tab.id, {
			auto: true,
			delayMs: nextItem.delayMs,
			url: nextItem.url,
			forceBody: Boolean(nextItem.forceBody)
		});
		debugLog("탭 오픈 성공", { tabId: tab.id, url: nextItem.url });
	});
}

chrome.tabs.onRemoved.addListener(tabId => {
	const meta = pendingTabs.get(tabId);
	if (!meta) return;
	debugLog("탭 종료 감지", { tabId, auto: meta.auto, url: meta.url });
	onAutoTabDone(tabId, meta);
});

chrome.runtime.onMessage.addListener(async (msg, sender) => {
	debugLog("메시지 수신", { type: msg?.type, tabId: sender.tab?.id });

	if (msg.type === "DEBUG_LOG") {
		const args = Array.isArray(msg.args) ? msg.args : [msg.message];
		debugLog("[CS]", ...args);
		return true;
	}

	if (msg.type === "OPEN_TAB") {
		queueOpenTab(msg.url, msg.delayMs, { forceBody: msg.forceBody });
		return true;
	}

	if (msg.type === "OPEN_TAB_BATCH") {
		const urls = Array.isArray(msg.urls) ? msg.urls : [];
		const delayMs = normalizeDelayMs(msg.delayMs);
		const forceBody = Boolean(msg.forceBody);
		urls.forEach(url => queueOpenTab(url, delayMs, { forceBody }));
		debugLog("배치 탭 큐 추가", { total: urls.length, delayMs, forceBody, queue: pendingQueue.length });
		openNext();
		return true;
	}

	if (msg.type === "SET_READY") {
		const tabId = sender.tab?.id;
		if (tabId) pendingTabs.set(tabId, { auto: false, delayMs: DEFAULT_OPEN_DELAY_MS });
		return true;
	}
	
	if (msg.type === "CONTENT_READY") {
		const tabId = sender.tab?.id;
		if (tabId && pendingTabs.has(tabId)) {
			const meta = pendingTabs.get(tabId);
			msg.type = "START_DOWNLOAD";
			if (meta?.forceBody) {
				msg.isEach = true;
				msg.forceBody = true;
			}
			chrome.tabs.sendMessage(tabId, msg);
		}
		return true;
	}

	if (msg.type === "DOWNLOAD") {
		const ext = await getReliableExtension(msg.url);
		const safeExt = ext.startsWith(".") ? ext.slice(1) : ext;
		const safeFolder = (msg.folder || "download").trim().replace(/^\/+|\/+$/g, "");
		const filename = `${safeFolder || "download"}/${msg.num}.${safeExt}`;
		debugLog("다운로드 요청", { url: msg.url, filename, ext: safeExt });
		chrome.downloads.download({
			url: msg.url,
			filename,
			conflictAction: "overwrite",
			saveAs: false
		}, downloadId => {
			if (chrome.runtime.lastError) {
				debugLog("다운로드 실패", chrome.runtime.lastError.message, filename);
			} else {
				debugLog("다운로드 시작", { downloadId, filename });
			}
		});
		return true;
	}

	if (msg.type === "COMPLETE") {
		const tabId = sender.tab?.id;
		if (tabId) {
			const meta = pendingTabs.get(tabId);
			if (msg.isSelf) {
				pendingTabs.delete(tabId);
			} else {
				chrome.tabs.remove(tabId, () => {
					if (chrome.runtime.lastError) debugLog("탭 닫기 실패", chrome.runtime.lastError.message);
					onAutoTabDone(tabId, meta || { auto: true, delayMs: DEFAULT_OPEN_DELAY_MS });
				});
			}
		}
		return true;
	}
});

const extensionMap = {
	'image/jpeg': '.jpg',
	'image/png': '.png',
	'image/gif': '.gif',
	'image/webp': '.webp',
	'image/svg+xml': '.svg',
	'image/bmp': '.bmp',
	'image/avif': '.avif'
};

function getExtensionFromMime(mimeType) {
	const cleanMime = mimeType ? mimeType.split(';')[0].toLowerCase() : '';
	return extensionMap[cleanMime] || null;
}

function extractExtFromDisposition(contentDisposition) {
	if (!contentDisposition) return null;
	
	const filenameMatch = contentDisposition.match(/filename\*?=["']?([^"';]+)["']?/i);
	if (filenameMatch && filenameMatch[1]) {
		const filenameFromHeader = decodeURIComponent(filenameMatch[1].trim());
		const lastDotIndex = filenameFromHeader.lastIndexOf('.');
		
		if (lastDotIndex > -1) {
			const ext = filenameFromHeader.substring(lastDotIndex).split('?')[0].toLowerCase();
			if (ext.length > 1 && ext.length <= 5 && /^\.[a-z0-9]+$/i.test(ext)) {
				return ext;
			}
		}
	}
	return null;
}

async function getReliableExtension(url) {
	const fallbackExtension = '.jpg';
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 5000);

	const parseHeaders = response => {
		const contentDisposition = response.headers.get('content-disposition');
		const contentType = response.headers.get('content-type');
		let actualExtension = extractExtFromDisposition(contentDisposition);
		if (!actualExtension && contentType) actualExtension = getExtensionFromMime(contentType);
		return actualExtension;
	};
	
	try {
		const response = await fetch(url, { 
			method: 'HEAD',
			signal: controller.signal
		});
		clearTimeout(timeoutId);

		if (response.ok) {
			const actualExtension = parseHeaders(response);
			controller.abort();
			if (actualExtension) return actualExtension;
		} else {
			debugLog("확장자 추론 응답 비정상", {
				url,
				status: response.status,
				contentType: response.headers.get("content-type")
			});

			if (response.status === 405) {
				const fallbackResp = await fetch(url, { method: "GET" });
				if (fallbackResp.ok) {
					const actualExtension = parseHeaders(fallbackResp);
					if (actualExtension) return actualExtension;
				}
			}
		}
	} catch (e) {
		debugLog("확장자 추론 실패", { url, error: e?.message });
		clearTimeout(timeoutId);
	}
	debugLog("확장자 기본값 사용", { url, fallbackExtension });
	return fallbackExtension;	
}
