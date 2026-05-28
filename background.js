let pendingQueue = [];
let opening = false;
const pendingTabs = new Map();
const downloadMetaById = new Map();
const pendingFilenameQueueByUrl = new Map();
const pendingDownloadQueue = [];
let autoProcessingTabId = null;
let nextOpenTimer = null;
let downloadQueueActive = false;
const DEFAULT_OPEN_DELAY_MS = 2000;
const MIN_OPEN_DELAY_MS = 500;
const MAX_OPEN_DELAY_MS = 10000;
const MAX_DOWNLOAD_DELAY_MS = 10000;
const DEBUG_KEY = "DebugMode";
const DEBUG_PREFIX = "[DCID Downloader][BG]";
const WINDOWS_RESERVED_NAME_REGEX = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const DETERMINE_EVENT_TIMEOUT_MS = 3000;
let debugEnabled = false;
let platformInfo = { os: "unknown", arch: "unknown", nacl_arch: "unknown" };
const pendingDetermineTimers = new Map();

chrome.runtime.getPlatformInfo(info => {
	if (info) platformInfo = info;
});

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

function enqueueExpectedFilename(url, filename) {
	if (!url || !filename) return;
	const list = pendingFilenameQueueByUrl.get(url) || [];
	list.push({
		url,
		filename,
		queuedAt: Date.now()
	});
	pendingFilenameQueueByUrl.set(url, list);
}

function dequeueExpectedFilename(url) {
	if (!url) return null;
	const list = pendingFilenameQueueByUrl.get(url);
	if (!list || !list.length) return null;
	const item = list.shift();
	if (!list.length) pendingFilenameQueueByUrl.delete(url);
	return item;
}

function normalizePathForCompare(path) {
	return String(path || "")
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")
		.toLowerCase();
}

function endsWithRelativePath(absolutePath, relativePath) {
	const abs = normalizePathForCompare(absolutePath);
	const rel = normalizePathForCompare(relativePath);
	return abs.endsWith(rel);
}

function toCodePointPreview(text, max = 24) {
	return Array.from(text || "")
		.slice(0, max)
		.map(ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}(${ch})`);
}

function analyzeRelativePath(path) {
	const value = typeof path === "string" ? path : "";
	const warnings = [];
	const segments = value.split("/");

	if (!value) warnings.push("path is empty");
	if (value.startsWith("/") || /^([a-zA-Z]:[\\/]|\\\\)/.test(value)) warnings.push("absolute path pattern");
	if (value.includes("..")) warnings.push("contains '..' sequence");
	if (value.includes("\\")) warnings.push("contains backslash");
	if (/^\s|\s$/.test(value)) warnings.push("path has leading/trailing whitespace");
	if (segments.some(seg => seg === "")) warnings.push("contains empty path segment");

	segments.forEach((seg, idx) => {
		if (!seg) return;
		if (/[\u0000-\u001F]/.test(seg)) warnings.push(`segment[${idx}] contains control char`);
		if (/[<>:"|?*]/.test(seg)) warnings.push(`segment[${idx}] contains Windows forbidden char`);
		if (/[. ]$/.test(seg)) warnings.push(`segment[${idx}] ends with dot/space`);
		if (/^[.]+$/.test(seg)) warnings.push(`segment[${idx}] dots-only segment`);
		if (WINDOWS_RESERVED_NAME_REGEX.test(seg)) warnings.push(`segment[${idx}] reserved Windows name`);
		if (seg.length > 240) warnings.push(`segment[${idx}] very long length=${seg.length}`);
	});

	return {
		path: value,
		length: value.length,
		segmentCount: segments.filter(Boolean).length,
		warnings,
		codePointPreview: toCodePointPreview(value)
	};
}

function clearDetermineTimer(downloadId) {
	const timer = pendingDetermineTimers.get(downloadId);
	if (!timer) return;
	clearTimeout(timer);
	pendingDetermineTimers.delete(downloadId);
}

function armDetermineTimer(downloadId) {
	if (!debugEnabled || typeof downloadId !== "number") return;
	clearDetermineTimer(downloadId);
	const timer = setTimeout(() => {
		pendingDetermineTimers.delete(downloadId);
		const meta = downloadMetaById.get(downloadId);
		if (meta && !meta.determineSeen) {
			debugLog("onDeterminingFilename 미수신", {
				id: downloadId,
				expectedRelative: meta.filename,
				url: meta.url,
				note: "브라우저/타 확장 개입 가능성"
			});
		}
	}, DETERMINE_EVENT_TIMEOUT_MS);
	pendingDetermineTimers.set(downloadId, timer);
}

function inspectDownloadItem(downloadId, label) {
	if (!debugEnabled || typeof downloadId !== "number") return;
	chrome.downloads.search({ id: downloadId }, items => {
		if (chrome.runtime.lastError) {
			debugLog(`다운로드 상세 조회 실패(${label})`, {
				id: downloadId,
				error: chrome.runtime.lastError.message
			});
			return;
		}
		const item = Array.isArray(items) ? items[0] : null;
		if (!item) {
			debugLog(`다운로드 상세 미발견(${label})`, { id: downloadId });
			return;
		}
		debugLog(`다운로드 상세(${label})`, {
			id: item.id,
			state: item.state,
			error: item.error,
			filename: item.filename,
			url: item.url,
			finalUrl: item.finalUrl,
			byExtensionId: item.byExtensionId,
			byExtensionName: item.byExtensionName,
			mime: item.mime,
			danger: item.danger,
			exists: item.exists
		});
	});
}

function normalizeDelayMs(rawValue) {
	const numeric = Number(rawValue);
	if (!Number.isFinite(numeric)) return DEFAULT_OPEN_DELAY_MS;
	return Math.max(MIN_OPEN_DELAY_MS, Math.min(MAX_OPEN_DELAY_MS, Math.round(numeric)));
}

function normalizeDownloadDelayMs(rawValue) {
	const numeric = Number(rawValue);
	if (!Number.isFinite(numeric)) return 0;
	return Math.max(0, Math.min(MAX_DOWNLOAD_DELAY_MS, Math.round(numeric)));
}

async function runDownload(msg) {
	const ext = await getReliableExtension(msg.url);
	const safeExt = ext.startsWith(".") ? ext.slice(1) : ext;
	const safeFolder = (msg.folder || "download").trim().replace(/^\/+|\/+$/g, "");
	const filename = `${safeFolder || "download"}/${msg.num}.${safeExt}`;
	enqueueExpectedFilename(msg.url, filename);
	const pathDiag = analyzeRelativePath(filename);
	debugLog("다운로드 요청", {
		url: msg.url,
		filename,
		ext: safeExt,
		platform: platformInfo,
		pathDiag,
		preferOriginal: Boolean(msg.preferOriginal),
		delayMs: normalizeDownloadDelayMs(msg.delayMs)
	});
	chrome.downloads.download({
		url: msg.url,
		filename,
		conflictAction: "overwrite",
		saveAs: false
	}, downloadId => {
		if (chrome.runtime.lastError) {
			debugLog("다운로드 실패", {
				error: chrome.runtime.lastError.message,
				filename,
				url: msg.url,
				platform: platformInfo,
				pathDiag
			});
		} else {
			const queuedMeta = dequeueExpectedFilename(msg.url);
			if (downloadId !== undefined) {
				const existingMeta = downloadMetaById.get(downloadId) || {};
				downloadMetaById.set(downloadId, {
					...existingMeta,
					filename: queuedMeta?.filename || filename,
					url: msg.url,
					startedAt: existingMeta.startedAt || Date.now(),
					source: "download-callback",
					determineSeen: Boolean(existingMeta.determineSeen),
					mismatchDetected: Boolean(existingMeta.mismatchDetected),
					preferOriginal: Boolean(msg.preferOriginal)
				});
				if (!downloadMetaById.get(downloadId)?.determineSeen) armDetermineTimer(downloadId);
				inspectDownloadItem(downloadId, "after-download-callback");
			}
			debugLog("다운로드 시작", { downloadId, filename });
		}
	});
}

function queueDownload(msg) {
	const delayMs = normalizeDownloadDelayMs(msg.delayMs);
	pendingDownloadQueue.push({ msg, delayMs });
	debugLog("다운로드 큐 추가", {
		queue: pendingDownloadQueue.length,
		delayMs,
		url: msg.url,
		preferOriginal: Boolean(msg.preferOriginal)
	});
	processDownloadQueue();
}

async function processDownloadQueue() {
	if (downloadQueueActive || !pendingDownloadQueue.length) return;
	downloadQueueActive = true;
	const item = pendingDownloadQueue.shift();
	debugLog("다운로드 큐 처리", {
		remainQueue: pendingDownloadQueue.length,
		delayMs: item.delayMs,
		url: item.msg.url,
		preferOriginal: Boolean(item.msg.preferOriginal)
	});

	try {
		await runDownload(item.msg);
	} catch (e) {
		debugLog("다운로드 큐 처리 실패", {
			url: item.msg.url,
			error: e?.message
		});
	}

	setTimeout(() => {
		downloadQueueActive = false;
		processDownloadQueue();
	}, item.delayMs);
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
		const delayMs = normalizeDownloadDelayMs(msg.delayMs);
		if (delayMs > 0) queueDownload(msg);
		else await runDownload(msg);
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

chrome.downloads.onCreated.addListener(downloadItem => {
	if (!debugEnabled) return;
	const isFromThisExtension = downloadItem.byExtensionId === chrome.runtime.id;
	if (!isFromThisExtension) return;

	const meta = downloadMetaById.get(downloadItem.id);
	if (meta) {
		meta.createdSeen = true;
		meta.createdSeenAt = Date.now();
		downloadMetaById.set(downloadItem.id, meta);
	}

	debugLog("다운로드 생성", {
		id: downloadItem.id,
		url: downloadItem.url,
		finalUrl: downloadItem.finalUrl,
		current: downloadItem.filename,
		byExtensionName: downloadItem.byExtensionName,
		meta
	});
	inspectDownloadItem(downloadItem.id, "onCreated");
});

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
	const isFromThisExtension = downloadItem.byExtensionId === chrome.runtime.id;
	if (!isFromThisExtension) {
		suggest();
		return;
	}

	let meta = downloadMetaById.get(downloadItem.id);
	if (!meta) {
		const queuedMeta =
			dequeueExpectedFilename(downloadItem.url) ||
			dequeueExpectedFilename(downloadItem.finalUrl);
		if (queuedMeta) {
			meta = {
				...queuedMeta,
				url: downloadItem.finalUrl || downloadItem.url,
				startedAt: Date.now(),
				source: "onDeterminingFilename"
			};
		}
	}

	if (meta) {
		meta.determineSeen = true;
		meta.determineSeenAt = Date.now();
		downloadMetaById.set(downloadItem.id, meta);
		clearDetermineTimer(downloadItem.id);
	}

	if (meta?.filename) {
		debugLog("파일명 강제 제안", {
			id: downloadItem.id,
			url: downloadItem.finalUrl || downloadItem.url,
			current: downloadItem.filename,
			suggested: meta.filename,
			byExtensionName: downloadItem.byExtensionName
		});
		suggest({ filename: meta.filename, conflictAction: "overwrite" });
		return;
	}

	debugLog("파일명 강제 제안 스킵(메타 없음)", {
		id: downloadItem.id,
		url: downloadItem.finalUrl || downloadItem.url,
		current: downloadItem.filename
	});
	suggest();
});

chrome.downloads.onChanged.addListener(delta => {
	if (!debugEnabled) return;
	const meta = downloadMetaById.get(delta.id) || {};
	const state = delta.state?.current;
	const error = delta.error?.current;
	const filename = delta.filename?.current || meta.filename;

	if (state || error || delta.paused) {
		debugLog("다운로드 상태 변경", {
			id: delta.id,
			state,
			error,
			paused: delta.paused?.current,
			filename,
			meta
		});
	}

	if (delta.filename?.current && meta.filename) {
		const matched = endsWithRelativePath(delta.filename.current, meta.filename);
		if (!matched) {
			meta.mismatchDetected = true;
			meta.actualFilename = delta.filename.current;
			meta.mismatchAt = Date.now();
			downloadMetaById.set(delta.id, meta);
			debugLog("파일명 불일치 감지(외부 개입 가능)", {
				id: delta.id,
				expectedRelative: meta.filename,
				actual: delta.filename.current
			});
		}
	}

	if (state === "complete" || state === "interrupted") {
		clearDetermineTimer(delta.id);
		inspectDownloadItem(delta.id, `onChanged:${state}`);
		downloadMetaById.delete(delta.id);
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
