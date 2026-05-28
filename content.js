let imageUrls = [];
let debugEnabled = false;
const DEBUG_KEY = "DebugMode";
const DEBUG_PREFIX = "[DCID Downloader][CS]";
const ORIGINAL_IMAGE_KEY = "OriginalImageDownload";
const ORIGINAL_DELAY_KEY = "OriginalDownloadDelayMs";
const DEFAULT_ORIGINAL_DELAY_MS = 500;
const LOADING_IMAGE_URL = "https://nstatic.dcinside.com/dc/m/img/gallview_loading_ori.gif";
const DCCON_IMAGE_PREFIX = "https://dcimg5.dcinside.com/dccon.php?no=";

function debugLog(...args) {
	if (!debugEnabled) return;
	console.log(DEBUG_PREFIX, ...args);
	chrome.runtime.sendMessage({ type: "DEBUG_LOG", args }, () => void chrome.runtime.lastError);
}

function normalizeUrl(rawUrl) {
	if (!rawUrl || typeof rawUrl !== "string") return null;
	try {
		const parsed = new URL(rawUrl, window.location.href);
		if (!/^https?:$/i.test(parsed.protocol)) return null;
		return parsed.href;
	} catch {
		return null;
	}
}

function normalizeDcImageUrl(rawUrl) {
	const normalized = normalizeUrl(rawUrl);
	if (!normalized) return null;

	try {
		const parsed = new URL(normalized);
		const isDcInsideHost = /(^|\.)dcinside\.co\.kr$/i.test(parsed.hostname);
		const isViewImagePath = /^\/viewimage\.php$/i.test(parsed.pathname);

		if (isDcInsideHost && isViewImagePath && parsed.hostname !== "image.dcinside.com") {
			const converted = `https://image.dcinside.com/viewimage.php${parsed.search}`;
			debugLog("이미지 URL 정규화", { before: normalized, after: converted });
			return converted;
		}
	} catch {
		return normalized;
	}

	return normalized;
}

function normalizeOriginalImageUrl(rawUrl) {
	const normalized = normalizeUrl(rawUrl);
	if (!normalized) return null;

	try {
		const parsed = new URL(normalized);
		const isImageHost = /^image\.dcinside\.com$/i.test(parsed.hostname);
		const isPopPath = /^\/viewimagePop\.php$/i.test(parsed.pathname);

		if (isImageHost && isPopPath) {
			const no = parsed.searchParams.get("no");
			if (no) {
				const directUrl = `https://image.dcinside.com/viewimage.php?id=&no=${encodeURIComponent(no)}`;
				debugLog("원본 이미지 URL 변환", { before: normalized, after: directUrl });
				return directUrl;
			}
		}
	} catch {
		return null;
	}

	const directUrl = normalizeDcImageUrl(normalized);
	if (!directUrl) return null;

	try {
		const parsed = new URL(directUrl);
		const isDcHost = /(^|\.)dcinside\.(com|co\.kr)$/i.test(parsed.hostname);
		const isViewImagePath = /^\/viewimage\.php$/i.test(parsed.pathname);
		if (isDcHost && isViewImagePath) return directUrl;
	} catch {
		return null;
	}

	return null;
}

function extractOriginalImageUrl(img) {
	const onclick = img.getAttribute("onclick") || img.getAttribute("onClick") || "";
	const onclickMatch = onclick.match(/imgPop\(\s*['"]([^'"]+)['"]/i);
	if (onclickMatch?.[1]) {
		const url = normalizeOriginalImageUrl(onclickMatch[1]);
		if (url) return url;
	}

	const parentLink = img.closest("a[href]");
	if (parentLink) {
		const href = parentLink.getAttribute("href");
		const url = normalizeOriginalImageUrl(href);
		if (url) return url;
	}

	return null;
}

function normalizeOriginalDelayMs(rawValue) {
	const numeric = Number(rawValue);
	if (!Number.isFinite(numeric)) return DEFAULT_ORIGINAL_DELAY_MS;
	return Math.max(0, Math.min(10000, Math.round(numeric)));
}

function collectImageUrls(options = {}) {
	const preferOriginal = Boolean(options.preferOriginal);
	const imgs = Array.from(document.querySelectorAll(".write_div img"));
	let originalFound = 0;
	let originalFallback = 0;
	const urls = imgs
		.map(img => {
			const src = img.getAttribute("src") || "";
			const original = img.getAttribute("data-original") || "";
			const dataSrc = img.getAttribute("data-src") || "";
			const candidate = src === LOADING_IMAGE_URL ? (original || dataSrc || src) : (src || original || dataSrc);
			const displayUrl = normalizeDcImageUrl(candidate);
			const originalUrl = preferOriginal ? extractOriginalImageUrl(img) : null;
			const normalized = originalUrl || displayUrl;
			const hasFileNo = img.hasAttribute("data-fileno");

			if (preferOriginal) {
				if (originalUrl) originalFound += 1;
				else if (displayUrl) originalFallback += 1;
			}

			let isDcViewImage = false;
			if (normalized) {
				try {
					const parsed = new URL(normalized);
					const isDcHost = /(^|\.)dcinside\.(com|co\.kr)$/i.test(parsed.hostname);
					isDcViewImage = isDcHost && /^\/viewimage\.php$/i.test(parsed.pathname);
				} catch {
					isDcViewImage = false;
				}
			}

			return {
				url: normalized,
				hasFileNo,
				isDcViewImage
			};
		})
		.filter(item => item.url && !item.url.startsWith(DCCON_IMAGE_PREFIX))
		.filter(item => item.hasFileNo || item.isDcViewImage)
		.map(item => item.url);

	const unique = Array.from(new Set(urls));
	debugLog("본문 이미지 수집", {
		total: imgs.length,
		valid: unique.length,
		excluded: Math.max(imgs.length - unique.length, 0),
		preferOriginal,
		originalFound,
		originalFallback
	});
	return unique;
}

(() => {
	chrome.storage.sync.get({ [DEBUG_KEY]: false }, data => {
		debugEnabled = Boolean(data[DEBUG_KEY]);
		if (debugEnabled) console.log(DEBUG_PREFIX, "디버그 모드 활성화");
	});

	chrome.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== "sync" || !changes[DEBUG_KEY]) return;
		debugEnabled = Boolean(changes[DEBUG_KEY].newValue);
		console.log(DEBUG_PREFIX, `디버그 모드 ${debugEnabled ? "활성화" : "비활성화"}`);
	});
})();

(() => {
	imageUrls = collectImageUrls();

	const zone1 = document.querySelector(".view_content_wrap");
	const zone2 = document.querySelector(".appending_file_box");
	if (!zone1 || !zone2) {
		debugLog("첨부 박스 미탐지: 레이아웃 이동/첨부 비교 스킵");
		return;
	}

	const firstChild = zone1.children[0];
	if (!firstChild) return;

	const STORAGE_KEY = "ElementMove";
	chrome.storage.sync.get(STORAGE_KEY, data => {
		const isEnabled = data[STORAGE_KEY];
		if (isEnabled) zone1.insertBefore(zone2, firstChild.nextSibling);
	});

	let flag = 0;
	const lisOrigin = document.querySelectorAll("ul.appending_file li");
	const lisSorted = new Set(Array.from(lisOrigin).map(li => li.textContent)).size;

	if (lisOrigin.length === lisSorted) flag = lisSorted !== imageUrls.length ? 1 : 2;

	const a = document.querySelector("a.btn_file_dw");
	if (!a) {
		debugLog("btn_file_dw 미탐지");
		return;
	}

	let box;
	switch (flag) {
		case 2:
			box = createBtn("다운로드 후 종료", "Later_Exit");
			box.onclick = () => {
				triggerNativeContentDownload(a);
				observeBtn(a);
			};
			break;
		case 1:
			box = createSign("첨부파일 수가 다름", false);
			break;
		case 0:
			box = createSign("다운로드 불가", true);
			break;
	}

	const anchor = a.nextElementSibling || a;
	anchor.after(box);
	debugLog("첨부 비교 결과", { lisOrigin: lisOrigin.length, lisSorted, imageUrls: imageUrls.length, flag });

	function createBtn(text, cls) {
		const btn = document.createElement("button");
		btn.textContent = text;
		btn.classList.add(cls);
		btn.style.fontSize = "11px";
		btn.style.color = "#ffffff";
		btn.style.backgroundColor = "#66ccff";
		btn.style.border = "1px solid #3399ff";
		btn.style.borderRadius = "4px";
		btn.style.padding = "0px 2px";
		btn.style.marginLeft = "15px";
		btn.style.cursor = "pointer";
		btn.addEventListener("mouseover", () => btn.style.backgroundColor = "#5ab0e6");
		btn.addEventListener("mouseout", () => btn.style.backgroundColor = "#66ccff");
		return btn;
	}

	function createSign(text, red) {
		const sign = document.createElement("div");
		sign.textContent = text;
		sign.style.fontSize = "11px";
		sign.style.color = "#ffffff";
		sign.style.borderRadius = "4px";
		sign.style.padding = "0px 2px";
		sign.style.marginLeft = "15px";
		sign.style.display = "inline-block";
		sign.style.cursor = "default";
		if (red) {
			sign.style.backgroundColor = "#ff6666";
			sign.style.border = "1px solid #cc0000";
		} else {
			sign.style.backgroundColor = "#ff9966";
			sign.style.border = "1px solid #ff6600";
		}
		return sign;
	}

	function triggerNativeContentDownload(anchor) {
		const originalHref = anchor.getAttribute("href") || "";
		const usesJsHref = /^javascript:/i.test(originalHref.trim());
		const preventDefault = event => event.preventDefault();

		if (usesJsHref) anchor.setAttribute("href", "#");
		anchor.addEventListener("click", preventDefault, true);
		anchor.dispatchEvent(new MouseEvent("click", {
			bubbles: true,
			cancelable: true,
			view: window
		}));
		anchor.removeEventListener("click", preventDefault, true);
		if (usesJsHref) anchor.setAttribute("href", originalHref);
		debugLog("네이티브 본문 다운로드 트리거", { usesJsHref });
	}

	function observeBtn(btn) {
		const obs = new MutationObserver(() => {
			if (btn.style.display === "none") {
				obs.disconnect();
				chrome.runtime.sendMessage({ type: "COMPLETE" });
			}
		});
		obs.observe(btn, { attributes: true, attributeFilter: ["style"] });
	}
})();

(() => {
	const dcSeries = document.querySelector("div.dc_series");
	if (!dcSeries) return;
	const BATCH_DELAY_MS = 2000;

	const linkList = dcSeries.querySelectorAll("a[href]");
	const currentPostId = new URLSearchParams(window.location.search).get("no");
	const seriesUrls = Array.from(linkList)
		.map(a => normalizeUrl(a.href))
		.filter(Boolean)
		.filter(url => {
			try {
				return new URL(url).searchParams.get("no") !== currentPostId;
			} catch {
				return true;
			}
		});
	const uniqueSeriesUrls = Array.from(new Set(seriesUrls));

	if (uniqueSeriesUrls.length > 1) {
		const batchBtn = createBtn(`전체 다운로드 (${uniqueSeriesUrls.length})`);
		batchBtn.style.display = "inline";
		batchBtn.style.marginRight = "8px";
		dcSeries.insertBefore(batchBtn, dcSeries.firstChild);
		batchBtn.onclick = () => {
			debugLog("시리즈 전체 다운로드 시작", {
				total: uniqueSeriesUrls.length,
				delayMs: BATCH_DELAY_MS
			});
				chrome.runtime.sendMessage({
					type: "OPEN_TAB_BATCH",
					urls: uniqueSeriesUrls,
					delayMs: BATCH_DELAY_MS,
					forceBody: true
				});
			};
		}

	linkList.forEach(a => {
		const btn = createBtn("다운로드");
		a.style.display = "inline";
		btn.style.display = "inline";
		a.parentNode.insertBefore(btn, a);
		btn.style.marginRight = "6px";
		btn.onclick = () => {
			const targetUrl = normalizeUrl(a.href);
			debugLog("시리즈 탭 다운로드", { url: targetUrl || a.href });
			chrome.runtime.sendMessage({
				type: "OPEN_TAB",
				url: targetUrl || a.href,
				delayMs: BATCH_DELAY_MS,
				forceBody: true
			});
		};
	});

	function createBtn(text) {
		const btn = document.createElement("button");
		btn.textContent = text;
		btn.style.fontSize = "11px";
		btn.style.color = "#ffffff";
		btn.style.backgroundColor = "#66ccff";
		btn.style.border = "1px solid #3399ff";
		btn.style.borderRadius = "4px";
		btn.style.padding = "0px 2px";
		btn.style.marginBottom = "4px";
		btn.style.cursor = "pointer";
		btn.addEventListener("mouseover", () => btn.style.backgroundColor = "#5ab0e6");
		btn.addEventListener("mouseout", () => btn.style.backgroundColor = "#66ccff");
		return btn;
	}
})();

(() => {
	const box = document.querySelector("div.gallview_head .fr > :first-child");
	if (!box) {
		debugLog("본문 다운로드 버튼 삽입 위치 미탐지");
		return;
	}

	const btn = createBtn("본문 이미지 다운로드");
	box.before(btn);

	btn.onclick = () => {
		debugLog("본문 이미지 다운로드 버튼 클릭");
		chrome.runtime.sendMessage({ type: "SET_READY" });
		chrome.runtime.sendMessage({ type: "CONTENT_READY", isEach: true, isSelf: true });
	};

	function createBtn(text) {
		const btn = document.createElement("button");
		btn.textContent = text;
		btn.style.fontSize = "12px";
		btn.style.color = "#ffffff";
		btn.style.backgroundColor = "#66ccff";
		btn.style.border = "1px solid #3399ff";
		btn.style.borderRadius = "4px";
		btn.style.padding = "1px 2px";
		btn.style.marginBottom = "4px";
		btn.style.marginRight = "6px";
		btn.style.cursor = "pointer";
		btn.addEventListener("mouseover", () => btn.style.backgroundColor = "#5ab0e6");
		btn.addEventListener("mouseout", () => btn.style.backgroundColor = "#66ccff");
		return btn;
	}
})();

(() => {
	let folderRule;
	let ignoreAttachment = false;
	let originalImageDownload = false;
	let originalDownloadDelayMs = DEFAULT_ORIGINAL_DELAY_MS;

	chrome.storage.sync.get({
		"IgnoreAttachment": false,
		"filenamePattern": "?title",
		[ORIGINAL_IMAGE_KEY]: false,
		[ORIGINAL_DELAY_KEY]: DEFAULT_ORIGINAL_DELAY_MS
	}, data => {
		ignoreAttachment = data.IgnoreAttachment;
		folderRule = data.filenamePattern;
		originalImageDownload = Boolean(data[ORIGINAL_IMAGE_KEY]);
		originalDownloadDelayMs = normalizeOriginalDelayMs(data[ORIGINAL_DELAY_KEY]);
		debugLog("설정 로드", {
			ignoreAttachment,
			folderRule,
			originalImageDownload,
			originalDownloadDelayMs
		});
		chrome.runtime.sendMessage({ type: "CONTENT_READY" });
	});

	chrome.runtime.onMessage.addListener(msg => {
		if (msg.type === "START_DOWNLOAD") {
			startDownloadLogic(msg);
		}
	});

	function startDownloadLogic(options) {
		const btn = document.querySelector(".Later_Exit");
		if (!ignoreAttachment && !options.isEach && !options.isSelf && btn) {
			debugLog("첨부 다운로드 + 탭 종료 경로 실행");
			btn.click();
			return;
		}

		const latestUrls = collectImageUrls({ preferOriginal: originalImageDownload });
		const targetUrls = latestUrls.length ? latestUrls : imageUrls;
		debugLog("본문 다운로드 경로 실행", {
			total: targetUrls.length,
			originalImageDownload,
			originalDownloadDelayMs
		});
		downloadImages(targetUrls, options);
	}

	function replaceDateKeywords(text) {
		const now = new Date();
		const YYYY = String(now.getFullYear());
		const MM = String(now.getMonth() + 1).padStart(2, "0");
		const DD = String(now.getDate()).padStart(2, "0");
		const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
		return text
			.replaceAll("?today", `${YYYY}${MM}${DD}`)
			.replaceAll("?wday", weekdays[now.getDay()]);
	}

	function buildFolderDiagnostics(folderPath) {
		const raw = String(folderPath || "");
		const segments = raw.split("/").filter(Boolean);
		const warnings = [];
		const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

		if (!raw) warnings.push("folder empty");
		if (/^\s|\s$/.test(raw)) warnings.push("leading/trailing whitespace");
		if (raw.includes("\\")) warnings.push("contains backslash");
		if (raw.includes("..")) warnings.push("contains '..'");

		segments.forEach((seg, idx) => {
			if (/[\u0000-\u001F]/.test(seg)) warnings.push(`segment[${idx}] control char`);
			if (/[<>:"|?*]/.test(seg)) warnings.push(`segment[${idx}] windows forbidden char`);
			if (/[. ]$/.test(seg)) warnings.push(`segment[${idx}] ends with dot/space`);
			if (/^[.]+$/.test(seg)) warnings.push(`segment[${idx}] dots-only`);
			if (windowsReserved.test(seg)) warnings.push(`segment[${idx}] reserved windows name`);
			if (seg.length > 240) warnings.push(`segment[${idx}] long length=${seg.length}`);
		});

		return {
			folder: raw,
			length: raw.length,
			segments,
			segmentCount: segments.length,
			warnings
		};
	}

	function sanitizeFolderPath(folderPath) {
		const raw = String(folderPath || "");
		const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
		const segments = raw
			.replace(/\\/g, "/")
			.split("/")
			.filter(Boolean)
			.map(segment => {
				let value = segment
					.replace(/[\u0000-\u001F\u007F]/g, "")
					.replace(/[<>:"|?*]/g, "_")
					.trim();
				value = value.replace(/[. ]+$/g, "");
				if (!value || /^[.]+$/.test(value)) value = "_";
				if (windowsReserved.test(value)) value = `${value}_`;
				if (value.length > 120) value = value.substring(0, 120).trim();
				if (!value) value = "_";
				return value;
			})
			.filter(Boolean);

		const normalized = segments.join("/").replace(/^\/+|\/+$/g, "");
		return normalized || "download";
	}

	function downloadImages(urls, options) {
		if (!Array.isArray(urls) || urls.length === 0) {
			debugLog("다운로드할 본문 이미지 없음");
			chrome.runtime.sendMessage({ type: "COMPLETE", isSelf: options.isSelf });
			return;
		}

		let folder = folderRule || "?title";

		if (folder.includes("?title")) {
			const titleNode = document.querySelector(".title_subject");
			let title = titleNode ? titleNode.textContent.trim() : document.title.trim() || "Unknown";
			title = title.replace(/[/\\?%*:|"<>]/g, "_").substring(0, 100);
			folder = folder.replaceAll("?title", title);
		}

		if (folder.includes("?id")) {
			const postId = new URLSearchParams(window.location.search).get("no") || "0";
			folder = folder.replaceAll("?id", postId);
		}

		if (folder.includes("?gall")) {
			const gallNode = document.querySelector(".page_head h2 > a");
			let gall = gallNode ? gallNode.textContent.trim() : document.title.trim() || "UnknownGall";
			gall = gall.replace(" 갤러리미니", "").replace(" 갤러리", "");
			gall = gall.replace(/[/\\?%*:|"<>]/g, "_").substring(0, 50);
			folder = folder.replaceAll("?gall", gall);
		}

		const rawFolder = replaceDateKeywords(folder).trim();
		folder = sanitizeFolderPath(rawFolder || "download");
		if (rawFolder !== folder) {
			debugLog("폴더명 정규화 적용", { before: rawFolder, after: folder });
		}
		debugLog("최종 폴더명", folder);
		debugLog("폴더 진단", buildFolderDiagnostics(folder));

		const downloadDelayMs = originalImageDownload ? originalDownloadDelayMs : 0;
		if (downloadDelayMs > 0) {
			debugLog("다운로드 간격 적용", { delayMs: downloadDelayMs, total: urls.length });
		}

		urls.forEach((url, index) => {
			const num = (index + 1).toString().padStart(3, "0");
			chrome.runtime.sendMessage({
				type: "DOWNLOAD",
				url,
				folder,
				num,
				delayMs: downloadDelayMs,
				preferOriginal: originalImageDownload
			});
		});

		const completeMessage = {
			type: "COMPLETE",
			isEach: options.isEach,
			isSelf: options.isSelf,
			url: window.location.href
		};
		chrome.runtime.sendMessage(completeMessage);
	}
})();
