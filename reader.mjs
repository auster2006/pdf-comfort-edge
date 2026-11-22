import {
  AnnotationEditorType, AnnotationMode, GlobalWorkerOptions, PasswordResponses, getDocument,
} from "./vendor/pdfjs/build/pdf.mjs";

const { EventBus, FindState, GenericL10n, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } =
  await import("./vendor/pdfjs/web/pdf_viewer.mjs");

const $ = (id) => document.getElementById(id);
const asset = (path) => new URL(`./vendor/pdfjs/${path}`, import.meta.url).href;
GlobalWorkerOptions.workerSrc = asset("build/pdf.worker.mjs");

const container = $("viewerContainer");
const home = $("home");
const status = $("status");
const grantAccess = $("grantAccess");
const fileInput = $("fileInput");
const urlInput = $("urlInput");
const passwordForm = $("passwordForm");
const passwordInput = $("passwordInput");
const documentName = $("documentName");
const navigation = $("navigation");
const pageNumber = $("pageNumber");
const pageCount = $("pageCount");
const previousPage = $("previousPage");
const nextPage = $("nextPage");
const zoom = $("zoom");
const findBar = $("findBar");
const findInput = $("findInput");
const findButton = $("findButton");
const findCount = $("findCount");
const brightness = $("brightness");
const ruler = $("ruler");
const rulerShade = $("rulerShade");
const modes = [...$("mode").querySelectorAll("button")];

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
const findController = new PDFFindController({ eventBus, linkService });
const l10n = new GenericL10n("zh-CN");
const viewer = new PDFViewer({
  container, eventBus, linkService, findController, l10n,
  annotationMode: AnnotationMode.ENABLE,
  annotationEditorMode: AnnotationEditorType.DISABLE,
  imageResourcesPath: asset("web/images/"),
});
linkService.setViewer(viewer);
void l10n.translate(container);

let loadingTask = null;
let openVersion = 0;
let destination = "";
let updatePassword = null;
let pendingUrl = null;

function setMode(mode) {
  document.body.dataset.mode = mode;
  for (const button of modes) button.ariaPressed = String(button.dataset.mode === mode);
}

function setBrightness(value) {
  brightness.value = value;
  $("brightnessValue").value = `${brightness.value}%`;
  document.body.style.setProperty("--brightness", Number(brightness.value) / 100);
}

function setRuler(enabled) {
  ruler.ariaPressed = String(enabled);
  rulerShade.hidden = !enabled || container.hidden;
}

const prefs = await chrome.storage.local.get({ mode: "dark", brightness: 100, ruler: false });
setMode(prefs.mode);
setBrightness(prefs.brightness);
setRuler(prefs.ruler);

$("mode").addEventListener("click", (event) => {
  const mode = event.target.closest("button")?.dataset.mode;
  if (!mode) return;
  setMode(mode);
  void chrome.storage.local.set({ mode });
});
brightness.addEventListener("input", () => setBrightness(brightness.value));
brightness.addEventListener("change", () => void chrome.storage.local.set({ brightness: Number(brightness.value) }));
ruler.addEventListener("click", () => {
  const enabled = ruler.ariaPressed === "false";
  setRuler(enabled);
  void chrome.storage.local.set({ ruler: enabled });
});
container.addEventListener("pointermove", (event) => {
  if (rulerShade.hidden) return;
  const height = container.clientHeight;
  const y = event.clientY - container.getBoundingClientRect().top;
  rulerShade.style.setProperty("--ruler-center", `${Math.max(0, Math.min(height, y))}px`);
});

function setLoaded(loaded) {
  home.hidden = loaded;
  container.hidden = !loaded;
  navigation.hidden = true;
  documentName.hidden = !loaded;
  showFind(false);
  setRuler(ruler.ariaPressed === "true");
}

function reset() {
  openVersion++;
  viewer.setDocument(null);
  linkService.setDocument(null);
  if (loadingTask) void loadingTask.destroy().catch(() => {});
  loadingTask = null;
  updatePassword = null;
  pendingUrl = null;
  passwordForm.hidden = true;
  passwordInput.value = "";
  grantAccess.hidden = true;
  findInput.value = "";
  findCount.textContent = "";
  zoom.value = "auto";
  document.title = "PDF 护眼阅读器";
  setLoaded(false);
  return openVersion;
}

function saveSource(url) {
  const hash = url ? `#${new URLSearchParams({ file: url.href })}` : "";
  history.replaceState(null, "", location.pathname + hash);
}

async function loadPdf(source, name, version, hash = "") {
  status.textContent = "正在打开 PDF…";
  try {
    const input = typeof source === "string"
      ? { url: source, withCredentials: /^https?:/.test(source) }
      : { data: new Uint8Array(await source.arrayBuffer()) };
    if (version !== openVersion) return;

    loadingTask = getDocument({
      ...input,
      cMapPacked: true,
      cMapUrl: asset("cmaps/"),
      standardFontDataUrl: asset("standard_fonts/"),
      wasmUrl: asset("wasm/"),
      iccUrl: asset("iccs/"),
    });
    loadingTask.onPassword = (callback, reason) => {
      if (version !== openVersion) return;
      updatePassword = callback;
      passwordForm.hidden = false;
      status.textContent = reason === PasswordResponses.INCORRECT_PASSWORD
        ? "密码不正确，请重试。" : "此 PDF 需要密码。";
      passwordInput.focus();
    };

    const pdf = await loadingTask.promise;
    if (version !== openVersion) return;

    status.textContent = "";
    passwordForm.hidden = true;
    updatePassword = null;
    documentName.textContent = name;
    documentName.title = name;
    document.title = `${name} · PDF 护眼阅读器`;
    destination = hash;
    pageCount.textContent = pdf.numPages;
    pageNumber.max = pdf.numPages;
    setLoaded(true);
    linkService.setDocument(pdf);
    viewer.setDocument(pdf);
  } catch (error) {
    if (version !== openVersion) return;
    passwordForm.hidden = true;
    updatePassword = null;
    status.textContent = error.name === "InvalidPDFException"
      ? "这个文件不是有效的 PDF。"
      : typeof source === "string"
        ? "无法读取这个 PDF 链接。可以先下载文件，再用「打开文件」阅读。"
        : "无法读取这个 PDF 文件。";
  }
}

function sourceName(url) {
  const name = url.pathname.split("/").filter(Boolean).at(-1) || url.hostname || "PDF";
  try { return decodeURIComponent(name); } catch { return name; }
}

async function openUrl(value, requestAccess = false) {
  const version = reset();
  const url = URL.parse(value);
  if (!url || !["http:", "https:", "file:"].includes(url.protocol) || url.username || url.password) {
    status.textContent = "请输入有效的 PDF 链接。";
    return;
  }
  saveSource(url);

  try {
    if (url.protocol === "file:") {
      if (!(await chrome.extension.isAllowedFileSchemeAccess())) {
        if (version === openVersion) status.textContent = "请选择本地文件，或在扩展详情中开启「允许访问文件 URL」后刷新。";
        return;
      }
    } else {
      urlInput.value = url.href;
      const scope = { origins: [`${url.protocol}//${url.hostname}/*`] };
      const allowed = requestAccess
        ? await chrome.permissions.request(scope)
        : await chrome.permissions.contains(scope);
      if (version !== openVersion) return;
      if (!allowed) {
        pendingUrl = url.href;
        grantAccess.hidden = false;
        status.textContent = `允许访问 ${url.host} 后即可打开这份 PDF。`;
        return;
      }
    }
  } catch {
    if (version === openVersion) status.textContent = "无法获得读取权限。可以先下载 PDF，再选择本地文件。";
    return;
  }

  if (version !== openVersion) return;
  const hash = url.hash.slice(1);
  url.hash = "";
  void loadPdf(url.href, sourceName(url), version, hash);
}

function openLocal(file) {
  if (!file) return;
  const version = reset();
  saveSource();
  urlInput.value = "";
  void loadPdf(file, file.name, version);
}

for (const id of ["openFile", "chooseFile"]) $(id).addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  openLocal(fileInput.files[0]);
  fileInput.value = "";
});
$("urlForm").addEventListener("submit", (event) => {
  event.preventDefault();
  void openUrl(urlInput.value.trim(), true);
});
grantAccess.addEventListener("click", () => {
  if (pendingUrl) void openUrl(pendingUrl, true);
});
passwordForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const password = passwordInput.value;
  passwordInput.value = "";
  passwordForm.hidden = true;
  status.textContent = "正在解锁 PDF…";
  updatePassword?.(password);
});

document.addEventListener("dragover", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  home.classList.add("drop-active");
});
document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) home.classList.remove("drop-active");
});
document.addEventListener("drop", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  home.classList.remove("drop-active");
  openLocal(event.dataTransfer.files[0]);
});

function updatePageControls(current) {
  pageNumber.value = current;
  previousPage.disabled = current <= 1;
  nextPage.disabled = current >= Number(pageNumber.max);
}

eventBus.on("pagesinit", () => {
  viewer.currentScaleValue = zoom.value;
  if (destination) linkService.setHash(destination);
  updatePageControls(viewer.currentPageNumber);
  navigation.hidden = false;
});
eventBus.on("pagechanging", ({ pageNumber: current }) => updatePageControls(current));
pageNumber.addEventListener("change", () => {
  const target = Math.max(1, Math.min(Number(pageNumber.max), Math.trunc(pageNumber.valueAsNumber)));
  if (Number.isFinite(target)) viewer.currentPageNumber = target;
  updatePageControls(viewer.currentPageNumber);
});
pageNumber.addEventListener("keydown", (event) => {
  if (event.key === "Enter") pageNumber.blur();
});
previousPage.addEventListener("click", () => viewer.previousPage());
nextPage.addEventListener("click", () => viewer.nextPage());
zoom.addEventListener("change", () => { viewer.currentScaleValue = zoom.value; });

function showFind(visible) {
  if (findBar.hidden === !visible) return;
  findBar.hidden = !visible;
  findButton.ariaExpanded = String(visible);
  if (visible) {
    findInput.focus();
    findInput.select();
  } else {
    eventBus.dispatch("findbarclose", { source: findBar });
  }
}

function find(type = "", findPrevious = false) {
  if (!findInput.value) findCount.textContent = "";
  eventBus.dispatch("find", {
    source: findBar, type, query: findInput.value, findPrevious, highlightAll: true,
  });
}

function updateFindCount({ matchesCount: { current, total }, state }) {
  if (!findInput.value) return;
  findCount.textContent = total ? `${current} / ${total}` : state === FindState.NOT_FOUND ? "未找到" : "";
}

eventBus.on("updatefindmatchescount", updateFindCount);
eventBus.on("updatefindcontrolstate", updateFindCount);
findButton.addEventListener("click", () => showFind(findBar.hidden));
$("findClose").addEventListener("click", () => { showFind(false); findButton.focus(); });
$("findPrevious").addEventListener("click", () => find("again", true));
findInput.addEventListener("input", () => find());
findBar.addEventListener("submit", (event) => { event.preventDefault(); find("again"); });
document.addEventListener("keydown", (event) => {
  if (navigation.hidden) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    showFind(true);
    findInput.focus();
  } else if (event.key === "Escape" && !findBar.hidden) {
    showFind(false);
    findButton.focus();
  }
});

const initialUrl = new URLSearchParams(location.hash.slice(1)).get("file");
if (initialUrl) void openUrl(initialUrl);
