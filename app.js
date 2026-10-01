"use strict";

const DEFAULT_STATE = {
  solved: 0,
  escalated: 0,
  ratingRequests: 0,
  country: "RU",
  doublePay: false,
  theme: null,
  rates: {
    RU: { solved: 0, escalated: 0 },
    BY: { solved: 0, escalated: 0 }
  }
};

const COUNTRY_META = {
  RU: { locale: "ru-RU", currency: "RUB", symbol: "БО", label: "РФ" },
  BY: { locale: "ru-BY", currency: "BYN", symbol: "БО", label: "РБ" }
};

let state = structuredClone(DEFAULT_STATE);
let db = null;
let backgroundUrl = null;
let pendingBackground = undefined;
let resetSnapshot = null;
let toastTimer = null;

const el = {
  solved: document.querySelector("#solvedValue"),
  escalated: document.querySelector("#escalatedValue"),
  ratingRequests: document.querySelector("#ratingValue"),
  calls: document.querySelector("#callsValue"),
  escalationPercent: document.querySelector("#escalationPercent"),
  ratingPercent: document.querySelector("#ratingPercent"),
  escalationBar: document.querySelector("#escalationBar"),
  ratingBar: document.querySelector("#ratingBar"),
  earnings: document.querySelector("#earningsValue"),
  rateHint: document.querySelector("#rateHint"),
  doublePay: document.querySelector("#doublePay"),
  countryRU: document.querySelector("#countryRU"),
  countryBY: document.querySelector("#countryBY"),
  settingsDialog: document.querySelector("#settingsDialog"),
  settingsOpen: document.querySelector("#settingsOpen"),
  settingsClose: document.querySelector("#settingsClose"),
  settingsForm: document.querySelector("#settingsForm"),
  solvedRate: document.querySelector("#solvedRate"),
  escalatedRate: document.querySelector("#escalatedRate"),
  currencySymbols: document.querySelectorAll(".currency-symbol"),
  backgroundInput: document.querySelector("#backgroundInput"),
  backgroundReset: document.querySelector("#backgroundReset"),
  backgroundPreview: document.querySelector("#backgroundPreview"),
  backgroundMessage: document.querySelector("#backgroundMessage"),
  resetButton: document.querySelector("#resetButton"),
  toast: document.querySelector("#toast"),
  undoReset: document.querySelector("#undoReset"),
  themeToggle: document.querySelector("#themeToggle")
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB недоступен"));
      return;
    }
    const request = indexedDB.open("support-counter-db", 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("app")) database.createObjectStore("app");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbGet(key) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve(undefined);
    const request = db.transaction("app", "readonly").objectStore("app").get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbSet(key, value) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    const request = db.transaction("app", "readwrite").objectStore("app").put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function normalizeState(saved) {
  if (!saved || typeof saved !== "object") return structuredClone(DEFAULT_STATE);
  const merged = {
    ...structuredClone(DEFAULT_STATE),
    ...saved,
    rates: {
      RU: { ...DEFAULT_STATE.rates.RU, ...saved.rates?.RU },
      BY: { ...DEFAULT_STATE.rates.BY, ...saved.rates?.BY }
    }
  };
  ["solved", "escalated", "ratingRequests"].forEach((key) => {
    merged[key] = Math.max(0, Math.trunc(Number(merged[key]) || 0));
  });
  ["RU", "BY"].forEach((country) => {
    ["solved", "escalated"].forEach((key) => {
      merged.rates[country][key] = Math.max(0, Number(merged.rates[country][key]) || 0);
    });
  });
  merged.country = merged.country === "BY" ? "BY" : "RU";
  merged.doublePay = Boolean(merged.doublePay);
  merged.theme = ["light", "dark"].includes(merged.theme) ? merged.theme : null;
  merged.ratingRequests = Math.min(merged.ratingRequests, merged.solved + merged.escalated);
  return merged;
}

async function saveState() {
  try {
    await dbSet("state", state);
  } catch (error) {
    console.error("Не удалось сохранить состояние:", error);
  }
}

function applyTheme() {
  const theme = state.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  el.themeToggle.setAttribute("aria-label", theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему");
}

function setBackground(blob) {
  if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
  backgroundUrl = blob ? URL.createObjectURL(blob) : null;
  document.body.classList.toggle("has-custom-background", Boolean(backgroundUrl));
  if (backgroundUrl) {
    const cssUrl = `url("${backgroundUrl}")`;
    document.body.style.setProperty("--custom-background", cssUrl);
    el.backgroundPreview.style.backgroundImage = cssUrl;
    el.backgroundPreview.style.backgroundSize = "cover";
  } else {
    document.body.style.removeProperty("--custom-background");
    el.backgroundPreview.style.removeProperty("background-image");
    el.backgroundPreview.style.removeProperty("background-size");
  }
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "0%";
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value)}%`;
}

function formatMoney(value) {
  const meta = COUNTRY_META[state.country];
  return new Intl.NumberFormat(meta.locale, {
    style: "currency",
    currency: meta.currency,
    currencyDisplay: "code",
    minimumFractionDigits: 3,
    maximumFractionDigits: 3
  }).format(value);
}

function animateOutput(output) {
  output.classList.remove("value-pop");
  requestAnimationFrame(() => output.classList.add("value-pop"));
}

function updateRateForm() {
  const meta = COUNTRY_META[state.country];
  const rates = state.rates[state.country];

  el.currencySymbols.forEach((node) => {
    node.textContent = meta.symbol;
  });

  el.solvedRate.value = rates.solved || "";
  el.escalatedRate.value = rates.escalated || "";
}

function render(changedOutput = null) {
  const calls = state.solved + state.escalated;
  if (state.ratingRequests > calls) state.ratingRequests = calls;
  const escalationPercent = calls ? (state.escalated / calls) * 100 : 0;
  const ratingPercent = calls ? (state.ratingRequests / calls) * 100 : 0;
  const rates = state.rates[state.country];
  const multiplier = state.doublePay ? 2 : 1;
  const earnings = (state.solved * rates.solved + state.escalated * rates.escalated) * multiplier;

  el.solved.value = state.solved;
  el.solved.textContent = state.solved;
  el.escalated.value = state.escalated;
  el.escalated.textContent = state.escalated;
  el.ratingRequests.value = state.ratingRequests;
  el.ratingRequests.textContent = state.ratingRequests;
  el.calls.value = calls;
  el.calls.textContent = calls;
  el.escalationPercent.value = formatPercent(escalationPercent);
  el.escalationPercent.textContent = formatPercent(escalationPercent);
  el.ratingPercent.value = formatPercent(ratingPercent);
  el.ratingPercent.textContent = formatPercent(ratingPercent);
  el.escalationBar.style.width = `${Math.min(100, escalationPercent)}%`;
  el.ratingBar.style.width = `${Math.min(100, ratingPercent)}%`;
  el.earnings.value = formatMoney(earnings);
  el.earnings.textContent = formatMoney(earnings);
  el.rateHint.textContent = rates.solved || rates.escalated
    ? `${formatMoney(rates.solved)} за решение · ${formatMoney(rates.escalated)} за эскалацию${state.doublePay ? " · тариф ×2" : ""}`
    : "Ставки не заданы";
  el.doublePay.checked = state.doublePay;
  el.countryRU.checked = state.country === "RU";
  el.countryBY.checked = state.country === "BY";

  document.querySelectorAll("[data-counter]").forEach((button) => {
    const key = button.dataset.counter;
    const delta = Number(button.dataset.delta);
    button.disabled = delta < 0 ? state[key] === 0 : key === "ratingRequests" && state.ratingRequests >= calls;
  });

  if (changedOutput) animateOutput(changedOutput);
}

function changeCounter(key, delta) {
  const next = state[key] + delta;
  if (next < 0) return;
  if (key === "ratingRequests" && next > state.solved + state.escalated) return;
  state[key] = next;
  if ((key === "solved" || key === "escalated") && state.ratingRequests > state.solved + state.escalated) {
    state.ratingRequests = state.solved + state.escalated;
  }
  render(el[key]);
  void saveState();
}

function selectCountry(country) {
  state.country = country;
  render(el.earnings);
  updateRateForm();
  void saveState();
}

function showToast() {
  clearTimeout(toastTimer);
  el.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => {
    el.toast.classList.remove("is-visible");
    resetSnapshot = null;
  }, 5000);
}

document.querySelectorAll("[data-counter]").forEach((button) => {
  button.addEventListener("click", () => changeCounter(button.dataset.counter, Number(button.dataset.delta)));
});

el.countryRU.addEventListener("change", () => selectCountry("RU"));
el.countryBY.addEventListener("change", () => selectCountry("BY"));

el.doublePay.addEventListener("change", () => {
  state.doublePay = el.doublePay.checked;
  render(el.earnings);
  void saveState();
});

el.themeToggle.addEventListener("click", () => {
  const active = document.documentElement.dataset.theme;
  state.theme = active === "dark" ? "light" : "dark";
  applyTheme();
  void saveState();
});

el.settingsOpen.addEventListener("click", () => {
  pendingBackground = undefined;
  updateRateForm();
  el.backgroundMessage.textContent = "PNG, JPG, WebP или GIF до 12 МБ. Фото хранится только в этом браузере.";
  el.backgroundMessage.classList.remove("error");
  el.settingsDialog.showModal();
});

el.settingsClose.addEventListener("click", () => el.settingsDialog.close());
el.settingsDialog.addEventListener("click", (event) => {
  if (event.target === el.settingsDialog) el.settingsDialog.close();
});

el.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.rates[state.country].solved = Math.max(0, Number(el.solvedRate.value) || 0);
  state.rates[state.country].escalated = Math.max(0, Number(el.escalatedRate.value) || 0);
  try {
    if (pendingBackground !== undefined) await dbSet("background", pendingBackground);
    await saveState();
    render(el.earnings);
    el.settingsDialog.close();
  } catch (error) {
    el.backgroundMessage.textContent = "Не удалось сохранить настройки в браузере.";
    el.backgroundMessage.classList.add("error");
    console.error(error);
  }
});

el.backgroundInput.addEventListener("change", () => {
  const [file] = el.backgroundInput.files;
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    el.backgroundMessage.textContent = "Выберите файл изображения.";
    el.backgroundMessage.classList.add("error");
    return;
  }
  if (file.size > 12 * 1024 * 1024) {
    el.backgroundMessage.textContent = "Файл больше 12 МБ. Выберите изображение меньшего размера.";
    el.backgroundMessage.classList.add("error");
    el.backgroundInput.value = "";
    return;
  }
  pendingBackground = file;
  setBackground(file);
  el.backgroundMessage.textContent = `Выбрано: ${file.name}. Нажмите «Сохранить».`;
  el.backgroundMessage.classList.remove("error");
});

el.backgroundReset.addEventListener("click", () => {
  pendingBackground = null;
  el.backgroundInput.value = "";
  setBackground(null);
  el.backgroundMessage.textContent = "Стандартный фон выбран. Нажмите «Сохранить».";
  el.backgroundMessage.classList.remove("error");
});

el.resetButton.addEventListener("click", () => {
  resetSnapshot = {
    solved: state.solved,
    escalated: state.escalated,
    ratingRequests: state.ratingRequests
  };
  state.solved = 0;
  state.escalated = 0;
  state.ratingRequests = 0;
  render(el.calls);
  void saveState();
  showToast();
});

el.undoReset.addEventListener("click", () => {
  if (!resetSnapshot) return;
  Object.assign(state, resetSnapshot);
  resetSnapshot = null;
  clearTimeout(toastTimer);
  el.toast.classList.remove("is-visible");
  render(el.calls);
  void saveState();
});

async function init() {
  try {
    db = await openDatabase();
    const [savedState, savedBackground] = await Promise.all([dbGet("state"), dbGet("background")]);
    state = normalizeState(savedState);
    if (savedBackground instanceof Blob) setBackground(savedBackground);
  } catch (error) {
    console.warn("Постоянное хранилище недоступно, данные сохранятся только до закрытия страницы.", error);
  }
  applyTheme();
  updateRateForm();
  render();
}

void init();
