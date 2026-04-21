const API_BASE = "https://api.dalilk4ielts.com";
const STORAGE_KEY = "qudrat-banks-v1";
const QUESTION_CACHE_KEY = "qudrat-question-cache-v1";
const QUESTION_SELECT = "id,classification,question,choices";
const QUESTION_CACHE_LIMIT = 360;
const FETCH_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 12000;

const SECTION_LABELS = {
  verbal: "لفظي",
  quant: "كمي",
  mixed: "لفظي + كمي",
};

const DISTRIBUTION_LABELS = {
  random: "عشوائي",
  all: "كل الفقرات",
  manual: "تحديد يدوي",
};

const state = {
  db: loadDb(),
  questionCache: loadQuestionCache(),
  catalogs: {
    verbal: null,
    quant: null,
  },
  catalogRequests: {
    verbal: null,
    quant: null,
  },
  ui: {
    view: "home",
    activeBankId: null,
    activeAttemptId: null,
    submitOverlay: false,
    createForm: {
      name: "",
      subjectMode: "verbal",
      questionCount: 20,
      distributionMode: "random",
      verbalRatio: 50,
      selectedClassifications: {
        verbal: [],
        quant: [],
      },
    },
    createBusy: false,
    createStatus: "",
    createError: "",
    homeInfo: "",
  },
};

const appEl = document.getElementById("app");

appEl.addEventListener("click", onClick);
appEl.addEventListener("change", onChange);
appEl.addEventListener("input", onInput);

init();

function init() {
  render();
  maybePreloadCatalogs();
}

function loadDb() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { banks: [] };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.banks)) {
      return { banks: [] };
    }
    return {
      banks: parsed.banks.map(normalizeBankRecord),
    };
  } catch (_error) {
    return { banks: [] };
  }
}

function loadQuestionCache() {
  try {
    const raw = localStorage.getItem(QUESTION_CACHE_KEY);
    if (!raw) {
      return {
        verbal: {},
        quant: {},
      };
    }
    const parsed = JSON.parse(raw);
    return {
      verbal: typeof parsed?.verbal === "object" && parsed.verbal ? parsed.verbal : {},
      quant: typeof parsed?.quant === "object" && parsed.quant ? parsed.quant : {},
    };
  } catch (_error) {
    return {
      verbal: {},
      quant: {},
    };
  }
}

function normalizeBankRecord(bank) {
  return {
    id: String(bank.id || uid("bank")),
    name: String(bank.name || "بنك بدون اسم"),
    createdAt: Number(bank.createdAt || Date.now()),
    config: {
      subjectMode: bank.config?.subjectMode || "verbal",
      questionCount: Number(bank.config?.questionCount || bank.questions?.length || 0),
      distributionMode: bank.config?.distributionMode || "random",
      verbalRatio: Number(bank.config?.verbalRatio ?? 50),
      selectedClassifications: {
        verbal: Array.isArray(bank.config?.selectedClassifications?.verbal)
          ? bank.config.selectedClassifications.verbal
          : [],
        quant: Array.isArray(bank.config?.selectedClassifications?.quant)
          ? bank.config.selectedClassifications.quant
          : [],
      },
      notes: Array.isArray(bank.config?.notes) ? bank.config.notes : [],
    },
    questions: Array.isArray(bank.questions) ? bank.questions : [],
    attempts: Array.isArray(bank.attempts)
      ? bank.attempts.map((attempt) => ({
          id: String(attempt.id || uid("attempt")),
          startedAt: Number(attempt.startedAt || Date.now()),
          completedAt: attempt.completedAt ? Number(attempt.completedAt) : null,
          currentIndex: Number(attempt.currentIndex || 0),
          answers: typeof attempt.answers === "object" && attempt.answers !== null ? attempt.answers : {},
          score: typeof attempt.score === "number" ? attempt.score : null,
          durationSec: typeof attempt.durationSec === "number" ? attempt.durationSec : null,
        }))
      : [],
  };
}

function persistDb() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.db));
}

function persistQuestionCache() {
  try {
    localStorage.setItem(QUESTION_CACHE_KEY, JSON.stringify(state.questionCache));
  } catch (_error) {}
}

function cacheQuestion(section, question) {
  const key = String(question?.sourceQuestionId || "");
  if (!key || (section !== "verbal" && section !== "quant")) {
    return;
  }

  const bucket = state.questionCache[section];
  bucket[key] = {
    ...question,
    cachedAt: Date.now(),
  };

  const ids = Object.keys(bucket);
  if (ids.length > QUESTION_CACHE_LIMIT) {
    ids
      .sort((a, b) => {
        const ta = Number(bucket[a]?.cachedAt || 0);
        const tb = Number(bucket[b]?.cachedAt || 0);
        return ta - tb;
      })
      .slice(0, ids.length - QUESTION_CACHE_LIMIT)
      .forEach((id) => {
        delete bucket[id];
      });
  }
}

function getCachedQuestions(section, classification, needCount, selectedIds) {
  if (section !== "verbal" && section !== "quant") {
    return [];
  }

  const bucket = Object.values(state.questionCache[section] || {});
  if (bucket.length === 0) {
    return [];
  }

  const filtered = bucket
    .filter((question) => {
      const idKey = `${section}:${question.sourceQuestionId}`;
      if (selectedIds.has(idKey)) {
        return false;
      }
      if (!classification) {
        return true;
      }
      return normalizeToken(question.classification) === normalizeToken(classification);
    })
    .sort((a, b) => Number(b.cachedAt || 0) - Number(a.cachedAt || 0));

  return filtered.slice(0, needCount).map((item) => ({ ...item }));
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function bankById(bankId) {
  return state.db.banks.find((bank) => bank.id === bankId) || null;
}

function attemptById(bank, attemptId) {
  return bank.attempts.find((attempt) => attempt.id === attemptId) || null;
}

function onClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  const action = target.dataset.action;

  if (action === "create-bank") {
    void createBank();
    return;
  }

  if (action === "refresh-catalog") {
    const section = target.dataset.section;
    if (section === "verbal" || section === "quant") {
      void loadCatalog(section, true);
    } else if (section === "all") {
      void Promise.all([loadCatalog("verbal", true), loadCatalog("quant", true)]);
    }
    return;
  }

  if (action === "select-all-classifications") {
    const section = target.dataset.section;
    if (section === "verbal" || section === "quant") {
      const catalog = state.catalogs[section] || [];
      state.ui.createForm.selectedClassifications[section] = catalog.map((item) => item.name);
      render();
    }
    return;
  }

  if (action === "clear-classifications") {
    const section = target.dataset.section;
    if (section === "verbal" || section === "quant") {
      state.ui.createForm.selectedClassifications[section] = [];
      render();
    }
    return;
  }

  if (action === "start-new-attempt") {
    const bankId = target.dataset.bankId;
    if (!bankId) {
      return;
    }
    startNewAttempt(bankId);
    return;
  }

  if (action === "resume-attempt") {
    const bankId = target.dataset.bankId;
    const attemptId = target.dataset.attemptId;
    if (!bankId || !attemptId) {
      return;
    }
    openAttempt(bankId, attemptId);
    return;
  }

  if (action === "open-result") {
    const bankId = target.dataset.bankId;
    const attemptId = target.dataset.attemptId;
    if (!bankId || !attemptId) {
      return;
    }
    openResult(bankId, attemptId);
    return;
  }

  if (action === "delete-bank") {
    const bankId = target.dataset.bankId;
    if (!bankId) {
      return;
    }
    removeBank(bankId);
    return;
  }

  if (action === "delete-attempt") {
    const bankId = target.dataset.bankId;
    const attemptId = target.dataset.attemptId;
    if (!bankId || !attemptId) {
      return;
    }
    removeAttempt(bankId, attemptId);
    return;
  }

  if (action === "go-home") {
    state.ui.view = "home";
    state.ui.activeBankId = null;
    state.ui.activeAttemptId = null;
    state.ui.submitOverlay = false;
    render();
    return;
  }

  if (action === "attempt-prev") {
    moveAttemptIndex(-1);
    return;
  }

  if (action === "attempt-next") {
    moveAttemptIndex(1);
    return;
  }

  if (action === "attempt-go") {
    const index = Number(target.dataset.index);
    jumpAttemptIndex(index);
    return;
  }

  if (action === "attempt-select") {
    const key = target.dataset.key;
    if (!key) {
      return;
    }
    selectAttemptChoice(key);
    return;
  }

  if (action === "attempt-submit") {
    state.ui.submitOverlay = true;
    render();
    return;
  }

  if (action === "cancel-submit") {
    state.ui.submitOverlay = false;
    render();
    return;
  }

  if (action === "confirm-submit") {
    finalizeAttempt();
  }
}

function onChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.matches("input[data-classification='true']")) {
    const input = target;
    const section = input.dataset.section;
    if (section !== "verbal" && section !== "quant") {
      return;
    }
    const list = new Set(state.ui.createForm.selectedClassifications[section]);
    if (input.checked) {
      list.add(input.value);
    } else {
      list.delete(input.value);
    }
    state.ui.createForm.selectedClassifications[section] = [...list];
    render();
    return;
  }

  if (target.id === "subjectMode") {
    const value = target.value;
    if (value === "verbal" || value === "quant" || value === "mixed") {
      state.ui.createForm.subjectMode = value;
      state.ui.createError = "";
      maybePreloadCatalogs();
      render();
    }
    return;
  }

  if (target.id === "distributionMode") {
    const value = target.value;
    if (value === "random" || value === "all" || value === "manual") {
      state.ui.createForm.distributionMode = value;
      state.ui.createError = "";
      maybePreloadCatalogs();
      render();
    }
  }
}

function onInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.id === "bankName") {
    state.ui.createForm.name = target.value;
    return;
  }

  if (target.id === "questionCount") {
    const count = Number(target.value);
    if (!Number.isNaN(count)) {
      state.ui.createForm.questionCount = count;
      render();
    }
    return;
  }

  if (target.id === "verbalRatio") {
    const ratio = Number(target.value);
    if (!Number.isNaN(ratio)) {
      state.ui.createForm.verbalRatio = ratio;
      render();
    }
  }
}

function currentAttemptContext() {
  const bank = bankById(state.ui.activeBankId);
  if (!bank) {
    return null;
  }
  const attempt = attemptById(bank, state.ui.activeAttemptId);
  if (!attempt) {
    return null;
  }
  return { bank, attempt };
}

function openAttempt(bankId, attemptId) {
  const bank = bankById(bankId);
  if (!bank) {
    return;
  }
  const attempt = attemptById(bank, attemptId);
  if (!attempt) {
    return;
  }
  state.ui.view = "attempt";
  state.ui.activeBankId = bankId;
  state.ui.activeAttemptId = attemptId;
  state.ui.submitOverlay = false;
  render();
}

function openResult(bankId, attemptId) {
  const bank = bankById(bankId);
  if (!bank) {
    return;
  }
  const attempt = attemptById(bank, attemptId);
  if (!attempt) {
    return;
  }
  state.ui.view = "result";
  state.ui.activeBankId = bankId;
  state.ui.activeAttemptId = attemptId;
  state.ui.submitOverlay = false;
  render();
}

function startNewAttempt(bankId) {
  const bank = bankById(bankId);
  if (!bank) {
    return;
  }

  const attempt = {
    id: uid("attempt"),
    startedAt: Date.now(),
    completedAt: null,
    currentIndex: 0,
    answers: {},
    score: null,
    durationSec: null,
  };

  bank.attempts.unshift(attempt);
  persistDb();
  openAttempt(bank.id, attempt.id);
}

function getLatestIncompleteAttempt(bank) {
  return bank.attempts.find((attempt) => !attempt.completedAt) || null;
}

function getLatestCompletedAttempt(bank) {
  return bank.attempts.find((attempt) => Boolean(attempt.completedAt)) || null;
}

function moveAttemptIndex(direction) {
  const context = currentAttemptContext();
  if (!context) {
    return;
  }

  const maxIndex = context.bank.questions.length - 1;
  const next = clamp(context.attempt.currentIndex + direction, 0, maxIndex);
  context.attempt.currentIndex = next;
  persistDb();
  render();
}

function jumpAttemptIndex(index) {
  const context = currentAttemptContext();
  if (!context) {
    return;
  }

  const maxIndex = context.bank.questions.length - 1;
  context.attempt.currentIndex = clamp(index, 0, maxIndex);
  persistDb();
  render();
}

function selectAttemptChoice(choiceKey) {
  const context = currentAttemptContext();
  if (!context || context.attempt.completedAt) {
    return;
  }

  const question = context.bank.questions[context.attempt.currentIndex];
  if (!question) {
    return;
  }

  const hasChoice = question.choices.some((choice) => choice.key === choiceKey);
  if (!hasChoice) {
    return;
  }

  context.attempt.answers[String(context.attempt.currentIndex)] = choiceKey;
  persistDb();
  render();
}

function finalizeAttempt() {
  const context = currentAttemptContext();
  if (!context || context.attempt.completedAt) {
    return;
  }

  const total = context.bank.questions.length;
  let score = 0;

  for (let i = 0; i < total; i += 1) {
    const question = context.bank.questions[i];
    const answer = context.attempt.answers[String(i)] || "";
    if (normalizeToken(answer) === normalizeToken(question.correctKey)) {
      score += 1;
    }
  }

  const completedAt = Date.now();
  context.attempt.completedAt = completedAt;
  context.attempt.score = score;
  context.attempt.durationSec = Math.max(1, Math.floor((completedAt - context.attempt.startedAt) / 1000));
  state.ui.submitOverlay = false;

  persistDb();
  openResult(context.bank.id, context.attempt.id);
}

function removeBank(bankId) {
  const bank = bankById(bankId);
  if (!bank) {
    return;
  }

  const yes = window.confirm(`تأكيد حذف البنك: ${bank.name}؟\nسيتم حذف كل المحاولات المرتبطة به.`);
  if (!yes) {
    return;
  }

  state.db.banks = state.db.banks.filter((item) => item.id !== bankId);
  persistDb();

  if (state.ui.activeBankId === bankId) {
    state.ui.view = "home";
    state.ui.activeBankId = null;
    state.ui.activeAttemptId = null;
  }

  render();
}

function removeAttempt(bankId, attemptId) {
  const bank = bankById(bankId);
  if (!bank) {
    return;
  }

  const attempt = attemptById(bank, attemptId);
  if (!attempt) {
    return;
  }

  const yes = window.confirm("تأكيد حذف هذه المحاولة؟");
  if (!yes) {
    return;
  }

  bank.attempts = bank.attempts.filter((item) => item.id !== attemptId);
  persistDb();

  if (state.ui.activeAttemptId === attemptId) {
    state.ui.view = "home";
    state.ui.activeAttemptId = null;
    state.ui.activeBankId = null;
  }

  render();
}

function getRequiredSections(subjectMode) {
  if (subjectMode === "mixed") {
    return ["verbal", "quant"];
  }
  return [subjectMode];
}

function maybePreloadCatalogs() {
  const { distributionMode, subjectMode } = state.ui.createForm;
  if (distributionMode === "random") {
    return;
  }
  const sections = getRequiredSections(subjectMode);
  for (const section of sections) {
    void loadCatalog(section, false);
  }
}

async function loadCatalog(section, force) {
  if (!force && state.catalogs[section]) {
    return state.catalogs[section];
  }

  if (!force && state.catalogRequests[section]) {
    return state.catalogRequests[section];
  }

  const request = (async () => {
    try {
      const url = `${API_BASE}/qs-bank/${section}/index.php/classification-count/?status=not:draft`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`تعذر تحميل فقرات ${SECTION_LABELS[section]}`);
      }

      const payload = await response.json();
      if (payload.status !== 200 || typeof payload.data !== "object" || !payload.data) {
        throw new Error(`بيانات الفقرات غير صالحة (${SECTION_LABELS[section]})`);
      }

      const catalog = Object.entries(payload.data)
        .map(([name, count]) => ({ name, count: Number(count || 0) }))
        .filter((item) => item.name && item.count > 0)
        .sort((a, b) => {
          if (b.count !== a.count) {
            return b.count - a.count;
          }
          return a.name.localeCompare(b.name, "ar");
        });

      state.catalogs[section] = catalog;
      return catalog;
    } finally {
      state.catalogRequests[section] = null;
      render();
    }
  })();

  state.catalogRequests[section] = request;
  render();

  return request;
}

function splitCount(total, subjectMode, verbalRatio) {
  if (subjectMode === "verbal") {
    return { verbal: total, quant: 0 };
  }
  if (subjectMode === "quant") {
    return { verbal: 0, quant: total };
  }

  const boundedRatio = clamp(Math.round(verbalRatio), 0, 100);
  let verbal = Math.round((total * boundedRatio) / 100);
  let quant = total - verbal;

  if (total > 1) {
    if (verbal === 0) {
      verbal = 1;
      quant = total - 1;
    }
    if (quant === 0) {
      quant = 1;
      verbal = total - 1;
    }
  }

  return { verbal, quant };
}

async function createBank() {
  if (state.ui.createBusy) {
    return;
  }

  const form = state.ui.createForm;
  const count = clamp(Math.floor(Number(form.questionCount || 0)), 5, 200);
  const subjectMode = form.subjectMode;
  const distributionMode = form.distributionMode;
  const split = splitCount(count, subjectMode, form.verbalRatio);

  const neededSections = getRequiredSections(subjectMode);

  state.ui.createBusy = true;
  state.ui.createError = "";
  state.ui.homeInfo = "";
  state.ui.createStatus = "جاري تجهيز البنك...";
  render();

  try {
    const notes = [];
    const plan = [];

    for (const section of neededSections) {
      const target = split[section];
      if (target <= 0) {
        continue;
      }

      let classifications = [];
      if (distributionMode === "all" || distributionMode === "manual") {
        const catalog = await loadCatalog(section, false);
        const catalogNames = catalog.map((item) => item.name);

        if (distributionMode === "all") {
          classifications = catalogNames;
          if (target < catalogNames.length) {
            notes.push(
              `${SECTION_LABELS[section]}: العدد المختار (${target}) أقل من عدد الفقرات (${catalogNames.length})، سيتم التغطية على ${target} فقرات.`
            );
          }
        } else {
          const selected = form.selectedClassifications[section] || [];
          classifications = selected.filter((name) => catalogNames.includes(name));
          if (classifications.length === 0) {
            throw new Error(`اختر فقرة واحدة على الأقل لقسم ${SECTION_LABELS[section]}.`);
          }
        }
      }

      plan.push({
        section,
        target,
        distributionMode,
        classifications,
      });
    }

    if (plan.length === 0) {
      throw new Error("لم يتم تحديد خطة سحب أسئلة صحيحة.");
    }

    const bucket = {
      verbal: [],
      quant: [],
    };

    const sectionProgress = {};
    let lastStatusRenderAt = 0;

    const syncStatus = (force) => {
      const now = Date.now();
      if (!force && now - lastStatusRenderAt < 120) {
        return;
      }
      lastStatusRenderAt = now;

      const parts = plan.map((item) => {
        const progress = sectionProgress[item.section];
        if (!progress) {
          return `${SECTION_LABELS[item.section]} 0/${item.target}`;
        }
        return `${SECTION_LABELS[item.section]} ${progress.current}/${progress.total}`;
      });

      state.ui.createStatus = `جاري السحب: ${parts.join(" | ")}`;
      render();
    };

    const results = await Promise.all(
      plan.map(async (item) => {
        const questions = await collectSectionQuestions(item, (current, targetValue, classification) => {
          sectionProgress[item.section] = {
            current,
            total: targetValue,
            classification,
          };
          syncStatus(false);
        });
        sectionProgress[item.section] = {
          current: item.target,
          total: item.target,
          classification: "",
        };
        syncStatus(true);
        return [item.section, questions];
      })
    );

    for (const [section, questions] of results) {
      bucket[section] = questions;
    }

    const merged = mergeQuestions(bucket.verbal, bucket.quant, subjectMode, count);
    if (merged.length !== count) {
      throw new Error(`تم سحب ${merged.length} سؤال فقط من أصل ${count}. حاول مرة أخرى.`);
    }

    const bank = {
      id: uid("bank"),
      name: form.name.trim() || `${SECTION_LABELS[subjectMode]} - ${count} سؤال`,
      createdAt: Date.now(),
      config: {
        subjectMode,
        questionCount: count,
        distributionMode,
        verbalRatio: form.verbalRatio,
        selectedClassifications: {
          verbal: [...form.selectedClassifications.verbal],
          quant: [...form.selectedClassifications.quant],
        },
        notes,
      },
      questions: merged,
      attempts: [],
    };

    state.db.banks.unshift(bank);
    persistDb();

    state.ui.createForm.name = "";
    state.ui.createStatus = "تم إنشاء البنك بنجاح.";
    state.ui.homeInfo = `تم حفظ البنك "${bank.name}"، وتقدر تعيد استخدامه بأي وقت.`;
    state.ui.createBusy = false;
    render();
  } catch (error) {
    state.ui.createBusy = false;
    state.ui.createStatus = "";
    state.ui.createError = error instanceof Error ? error.message : "تعذر إنشاء البنك.";
    render();
  } finally {
    persistQuestionCache();
  }
}

function buildClassificationQueue(classifications, target, mode) {
  const unique = [...new Set(classifications.filter(Boolean))];
  if (unique.length === 0) {
    return [];
  }

  if (mode === "all" && target < unique.length) {
    return shuffle([...unique]).slice(0, target);
  }

  return unique;
}

function buildClassificationTargets(queue, target, distributionMode) {
  if (distributionMode === "random" || queue.length === 0) {
    return [{ classification: null, target }];
  }

  if (queue.length >= target) {
    return shuffle([...queue])
      .slice(0, target)
      .map((classification) => ({ classification, target: 1 }));
  }

  const base = Math.floor(target / queue.length);
  let rest = target % queue.length;

  return queue.map((classification) => {
    const extra = rest > 0 ? 1 : 0;
    if (rest > 0) {
      rest -= 1;
    }
    return {
      classification,
      target: base + extra,
    };
  });
}

async function collectSectionQuestions(plan, onProgress) {
  const { section, target, distributionMode, classifications } = plan;
  const queue = buildClassificationQueue(classifications, target, distributionMode);

  if (distributionMode !== "random" && queue.length === 0) {
    throw new Error(`لا توجد فقرات متاحة حاليًا لقسم ${SECTION_LABELS[section]}.`);
  }

  const groups = buildClassificationTargets(queue, target, distributionMode).map((group) => ({
    ...group,
    current: 0,
  }));

  const selected = [];
  const seen = new Set();

  for (const group of groups) {
    const cached = getCachedQuestions(section, group.classification, group.target, seen);
    for (const question of cached) {
      const key = `${section}:${question.sourceQuestionId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      selected.push(question);
      group.current += 1;
      onProgress(selected.length, target, group.classification || "من الكاش");
      if (selected.length >= target) {
        break;
      }
    }
    if (selected.length >= target) {
      break;
    }
  }

  const tasks = [];
  for (const group of groups) {
    const missing = Math.max(0, group.target - group.current);
    for (let i = 0; i < missing; i += 1) {
      tasks.push({ classification: group.classification });
    }
  }

  shuffle(tasks);

  const takeQuestion = (parsed, classificationLabel) => {
    if (!parsed || parsed.choices.length === 0) {
      return false;
    }

    const key = `${section}:${parsed.sourceQuestionId}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    selected.push(parsed);
    cacheQuestion(section, parsed);
    onProgress(selected.length, target, classificationLabel || null);
    return true;
  };

  const fetchByTask = async (classification) => {
    const maxRetries = classification ? 12 : 10;
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const rawQuestion = await fetchSingleQuestion(section, classification);
      if (!rawQuestion) {
        continue;
      }

      const parsed = normalizeQuestion(rawQuestion, section);
      if (!parsed || parsed.choices.length === 0) {
        continue;
      }

      if (classification && normalizeToken(parsed.classification) !== normalizeToken(classification)) {
        cacheQuestion(section, parsed);
        continue;
      }

      if (takeQuestion(parsed, classification)) {
        return true;
      }
    }
    return false;
  };

  if (tasks.length > 0) {
    let pointer = 0;
    const failedTasks = [];
    const workerCount = Math.min(FETCH_CONCURRENCY, tasks.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (pointer < tasks.length && selected.length < target) {
          const taskIndex = pointer;
          pointer += 1;
          const task = tasks[taskIndex];
          const done = await fetchByTask(task.classification);
          if (!done) {
            failedTasks.push(task);
          }
        }
      })
    );

    if (selected.length < target && failedTasks.length > 0) {
      for (const task of failedTasks) {
        if (selected.length >= target) {
          break;
        }
        await fetchByTask(task.classification);
      }
    }
  }

  if (selected.length < target) {
    const fallbackMax = Math.max(30, (target - selected.length) * 14);
    let fallback = 0;
    while (selected.length < target && fallback < fallbackMax) {
      fallback += 1;
      const rawQuestion = await fetchSingleQuestion(section, null);
      if (!rawQuestion) {
        continue;
      }
      const parsed = normalizeQuestion(rawQuestion, section);
      if (takeQuestion(parsed, "احتياطي")) {
        continue;
      }
    }
  }

  if (selected.length < target) {
    throw new Error(`تعذر جمع ${target} سؤال كافي لقسم ${SECTION_LABELS[section]}.`);
  }

  return shuffle(selected).slice(0, target);
}

async function fetchSingleQuestion(section, classification) {
  const url = new URL(`${API_BASE}/qs-bank/${section}/index.php`);
  url.searchParams.set("select", QUESTION_SELECT);
  url.searchParams.set("random", "1");
  url.searchParams.set("status", "not:draft");
  if (classification) {
    url.searchParams.set("classification", classification);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    if (payload.status !== 200 || !Array.isArray(payload.data) || payload.data.length === 0) {
      return null;
    }
    return payload.data[0];
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeQuestion(raw, section) {
  const parsedChoices = parseChoices(raw.choices);
  if (!parsedChoices || parsedChoices.options.length === 0) {
    return null;
  }

  const questionText = toText(raw.question);
  // استخراج القطعة من الحقول المختلفة
  const passage = extractPassage(questionText, raw.resource, raw.note, raw.classification);

  return {
    source: section,
    sourceQuestionId: raw.id,
    classification: toText(raw.classification),
    resource: toText(raw.resource),
    question: questionText,
    passage: passage, // إضافة القطعة القرائية
    level: toText(raw.level),
    note: toText(raw.note),
    videoUrl: raw.video_url ? String(raw.video_url) : "",
    shortcuts: Array.isArray(raw.shortcuts) ? raw.shortcuts : [],
    choices: parsedChoices.options,
    correctKey: resolveCorrectKey(parsedChoices.correct, parsedChoices.options),
  };
}

function extractPassage(question, resource, note, classification) {
  // محاولة استخراج القطعة من الحقول المختلفة
  // الأولوية: resource، ثم note، ثم الجزء الأول من السؤال

  if (resource && resource.trim().length > 30) {
    return resource.trim();
  }

  if (note && note.trim().length > 30) {
    return note.trim();
  }

  // إذا كان السؤال طويل، نفترض أن الجزء الأول هو القطعة
  if (question && question.length > 150) {
    // محاولة فصل القطعة عن السؤال
    const lines = question.split('\n');
    if (lines.length > 1) {
      // الجزء الأول يكون القطعة
      return lines.slice(0, -1).join('\n').trim();
    }
  }

  return resource || note || "";
}

function parseChoices(choicesRaw) {
  let parsed = null;
  if (typeof choicesRaw === "string") {
    try {
      parsed = JSON.parse(choicesRaw);
    } catch (_error) {
      return null;
    }
  } else if (choicesRaw && typeof choicesRaw === "object") {
    parsed = choicesRaw;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const optionKeys = Object.keys(parsed).filter((key) => key !== "correct");
  if (optionKeys.length === 0) {
    return null;
  }

  optionKeys.sort((a, b) => optionRank(a) - optionRank(b));

  const options = optionKeys.map((key) => {
    const item = parsed[key];
    if (item && typeof item === "object") {
      return {
        key,
        label: toText(item.label || key.toUpperCase()),
        text: toText(item.value),
      };
    }

    return {
      key,
      label: key.toUpperCase(),
      text: toText(item),
    };
  });

  return {
    options,
    correct: parsed.correct,
  };
}

function resolveCorrectKey(rawCorrect, options) {
  const token = normalizeToken(rawCorrect);
  if (!token) {
    return "";
  }

  const byKey = options.find((option) => normalizeToken(option.key) === token);
  if (byKey) {
    return byKey.key;
  }

  const byLabel = options.find((option) => normalizeToken(option.label) === token);
  if (byLabel) {
    return byLabel.key;
  }

  const mapped = mapArabicTokenToLatin(token);
  if (mapped) {
    const matched = options.find((option) => normalizeToken(option.key) === mapped);
    if (matched) {
      return matched.key;
    }
  }

  return token;
}

function mapArabicTokenToLatin(token) {
  const map = {
    "أ": "a",
    "ا": "a",
    "ب": "b",
    "ج": "c",
    "د": "d",
    "هـ": "e",
    "ه": "e",
  };

  return map[token] || "";
}

function optionRank(key) {
  const ranks = ["a", "b", "c", "d", "e", "f"];
  const normalized = normalizeToken(key);
  const index = ranks.indexOf(normalized);
  if (index >= 0) {
    return index;
  }
  return 99;
}

function mergeQuestions(verbalQuestions, quantQuestions, subjectMode, total) {
  if (subjectMode === "verbal") {
    return verbalQuestions.slice(0, total);
  }
  if (subjectMode === "quant") {
    return quantQuestions.slice(0, total);
  }

  const merged = [];
  const verbal = [...verbalQuestions];
  const quant = [...quantQuestions];

  while (merged.length < total && (verbal.length > 0 || quant.length > 0)) {
    if (verbal.length > 0) {
      merged.push(verbal.shift());
      if (merged.length >= total) {
        break;
      }
    }
    if (quant.length > 0) {
      merged.push(quant.shift());
    }
  }

  return merged.slice(0, total);
}

function render() {
  appEl.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <div class="brand__badge"></div>
        <div>
          <h1>بنوك القدرات الذكية</h1>
          <p>بنفس فكرة الفورمز - بنك محفوظ وتقدر تعيده أكثر من مرة</p>
        </div>
      </div>
      ${state.ui.view !== "home" ? '<button class="btn btn--secondary" data-action="go-home">رجوع للبنوك</button>' : ""}
    </header>
    <main class="view">
      ${renderView()}
    </main>
    ${state.ui.submitOverlay ? renderSubmitOverlay() : ""}
  `;
}

function renderView() {
  if (state.ui.view === "attempt") {
    return renderAttemptView();
  }
  if (state.ui.view === "result") {
    return renderResultView();
  }
  return renderHomeView();
}

function renderHomeView() {
  return `
    <section class="grid">
      <article class="card col-4">
        <div class="card__head">
          <div>
            <h2 class="card__title">إنشاء بنك جديد</h2>
            <p class="card__sub">حدد القسم، العدد، ونمط توزيع الفقرات</p>
          </div>
          <span class="pill">ثابت + قابل للإعادة</span>
        </div>
        <div class="stack">
          <div class="field">
            <label for="bankName">اسم البنك (اختياري)</label>
            <input id="bankName" type="text" value="${escapeAttr(state.ui.createForm.name)}" placeholder="مثال: بنك لفظي - التناظر" />
          </div>

          <div class="field">
            <label for="subjectMode">نوع الأسئلة</label>
            <select id="subjectMode">
              <option value="verbal" ${state.ui.createForm.subjectMode === "verbal" ? "selected" : ""}>لفظي</option>
              <option value="quant" ${state.ui.createForm.subjectMode === "quant" ? "selected" : ""}>كمي</option>
              <option value="mixed" ${state.ui.createForm.subjectMode === "mixed" ? "selected" : ""}>كلهم (لفظي + كمي)</option>
            </select>
          </div>

          ${
            state.ui.createForm.subjectMode === "mixed"
              ? `
            <div class="field">
              <label for="verbalRatio">نسبة اللفظي داخل البنك (%)</label>
              <input id="verbalRatio" type="number" min="0" max="100" value="${state.ui.createForm.verbalRatio}" />
              <p class="hint">التقسيم الحالي: ${renderSplitHint()}</p>
            </div>
          `
              : ""
          }

          <div class="field">
            <label for="questionCount">عدد الأسئلة</label>
            <input id="questionCount" type="number" min="5" max="200" value="${state.ui.createForm.questionCount}" />
            <p class="hint">الحد الأدنى 5 والحد الأعلى 200</p>
          </div>

          <div class="field">
            <label for="distributionMode">طريقة اختيار الفقرات</label>
            <select id="distributionMode">
              <option value="random" ${state.ui.createForm.distributionMode === "random" ? "selected" : ""}>عشوائي</option>
              <option value="all" ${state.ui.createForm.distributionMode === "all" ? "selected" : ""}>كل الفقرات</option>
              <option value="manual" ${state.ui.createForm.distributionMode === "manual" ? "selected" : ""}>تحديد يدوي أدق</option>
            </select>
          </div>

          ${renderClassificationControls()}

          <div class="row row--middle">
            <button class="btn btn--primary" data-action="create-bank" ${state.ui.createBusy ? "disabled" : ""}>${
              state.ui.createBusy ? "جاري الإنشاء..." : "إنشاء البنك"
            }</button>
            <button class="btn btn--ghost" data-action="refresh-catalog" data-section="all" ${
              state.ui.createBusy ? "disabled" : ""
            }>تحديث الفقرات</button>
          </div>

          ${
            state.ui.createStatus
              ? `<p class="status ${state.ui.createBusy ? "" : "status--ok"}">${escapeHtml(state.ui.createStatus)}</p>`
              : ""
          }
          ${state.ui.createError ? `<p class="status status--err">${escapeHtml(state.ui.createError)}</p>` : ""}
          ${state.ui.homeInfo ? `<p class="status status--ok">${escapeHtml(state.ui.homeInfo)}</p>` : ""}
        </div>
      </article>

      <article class="card col-8">
        <div class="card__head">
          <div>
            <h2 class="card__title">البنوك المحفوظة</h2>
            <p class="card__sub">كل بنك ثابت، وتقدر تبدأ له محاولات جديدة بأي وقت</p>
          </div>
          <span class="pill pill--warm">${state.db.banks.length} بنك</span>
        </div>
        ${renderBankList()}
      </article>
    </section>
  `;
}

function renderSplitHint() {
  const count = clamp(Math.floor(Number(state.ui.createForm.questionCount || 0)), 5, 200);
  const split = splitCount(count, state.ui.createForm.subjectMode, state.ui.createForm.verbalRatio);
  return `لفظي ${split.verbal} / كمي ${split.quant}`;
}

function renderClassificationControls() {
  const mode = state.ui.createForm.distributionMode;
  if (mode === "random") {
    return "<p class=\"hint\">سيتم سحب الأسئلة عشوائيًا من القسم المحدد.</p>";
  }

  const sections = getRequiredSections(state.ui.createForm.subjectMode);
  return sections
    .map((section) => {
      const loading = Boolean(state.catalogRequests[section]);
      const catalog = state.catalogs[section];
      const selectedSet = new Set(state.ui.createForm.selectedClassifications[section]);

      return `
        <div class="card" style="padding: 10px; border-radius: 12px;">
          <div class="card__head" style="margin-bottom: 8px;">
            <div>
              <h3 class="card__title" style="font-size: 0.95rem;">فقرات ${SECTION_LABELS[section]}</h3>
              <p class="card__sub">${catalog ? `${catalog.length} فقرة` : "لم يتم التحميل بعد"}</p>
            </div>
            <div class="row">
              <button class="btn btn--ghost" data-action="refresh-catalog" data-section="${section}" ${loading ? "disabled" : ""}>تحديث</button>
              ${
                mode === "manual"
                  ? `<button class="btn btn--ghost" data-action="select-all-classifications" data-section="${section}">الكل</button>
                     <button class="btn btn--ghost" data-action="clear-classifications" data-section="${section}">مسح</button>`
                  : ""
              }
            </div>
          </div>

          ${
            loading
              ? '<p class="hint">جاري تحميل الفقرات...</p>'
              : !catalog || catalog.length === 0
              ? '<p class="hint">لا توجد فقرات متاحة حاليًا.</p>'
              : mode === "all"
              ? '<p class="hint">سيتم التوزيع على كل الفقرات قدر الإمكان حسب عدد الأسئلة.</p>'
              : `
                <div class="checkbox-list">
                  ${catalog
                    .map(
                      (item) => `
                    <div class="checkbox-item">
                      <label>
                        <input
                          type="checkbox"
                          data-classification="true"
                          data-section="${section}"
                          value="${escapeAttr(item.name)}"
                          ${selectedSet.has(item.name) ? "checked" : ""}
                        />
                        <span>${escapeHtml(item.name)}</span>
                      </label>
                      <small>${item.count}</small>
                    </div>
                  `
                    )
                    .join("")}
                </div>
                <p class="tiny">المحدد الآن: ${selectedSet.size}</p>
              `
          }
        </div>
      `;
    })
    .join("");
}

function renderBankList() {
  if (state.db.banks.length === 0) {
    return '<div class="empty">ما فيه بنوك إلى الآن. أنشئ بنكك الأول من اليسار.</div>';
  }

  return `
    <div class="bank-list">
      ${state.db.banks.map(renderBankCard).join("")}
    </div>
  `;
}

function renderBankCard(bank) {
  const incomplete = getLatestIncompleteAttempt(bank);
  const completed = getLatestCompletedAttempt(bank);
  const attemptsCount = bank.attempts.length;
  const completedCount = bank.attempts.filter((attempt) => Boolean(attempt.completedAt)).length;

  return `
    <article class="bank-card">
      <div class="bank-head">
        <div>
          <h3 class="bank-name">${escapeHtml(bank.name)}</h3>
          <p class="bank-meta">
            ${SECTION_LABELS[bank.config.subjectMode]} - ${bank.questions.length} سؤال - ${DISTRIBUTION_LABELS[bank.config.distributionMode]} - ${formatDate(bank.createdAt)}
          </p>
        </div>
        <div class="row">
          <span class="pill">${completedCount} مكتمل</span>
          <span class="pill pill--muted">${attemptsCount} محاولة</span>
        </div>
      </div>

      ${
        Array.isArray(bank.config.notes) && bank.config.notes.length > 0
          ? `<div class="stack">${bank.config.notes.map((note) => `<p class="hint">- ${escapeHtml(note)}</p>`).join("")}</div>`
          : ""
      }

      <div class="row">
        ${
          incomplete
            ? `<button class="btn btn--primary" data-action="resume-attempt" data-bank-id="${bank.id}" data-attempt-id="${incomplete.id}">متابعة المحاولة</button>`
            : `<button class="btn btn--primary" data-action="start-new-attempt" data-bank-id="${bank.id}">ابدأ الآن</button>`
        }
        <button class="btn btn--secondary" data-action="start-new-attempt" data-bank-id="${bank.id}">محاولة جديدة</button>
        ${
          completed
            ? `<button class="btn btn--ghost" data-action="open-result" data-bank-id="${bank.id}" data-attempt-id="${completed.id}">آخر نتيجة</button>`
            : ""
        }
        <button class="btn btn--danger" data-action="delete-bank" data-bank-id="${bank.id}">حذف البنك</button>
      </div>

      <div class="attempt-list">
        ${
          bank.attempts.length === 0
            ? '<p class="hint">لا توجد محاولات حتى الآن.</p>'
            : bank.attempts
                .slice(0, 5)
                .map(
                  (attempt) => `
              <div class="attempt-row">
                <span>
                  ${attempt.completedAt ? "مكتمل" : "غير مكتمل"} - ${formatDate(attempt.startedAt)}
                  ${attempt.completedAt ? `- الدرجة ${attempt.score}/${bank.questions.length}` : ""}
                </span>
                <span class="row">
                  ${
                    attempt.completedAt
                      ? `<button class="btn btn--ghost" data-action="open-result" data-bank-id="${bank.id}" data-attempt-id="${attempt.id}">عرض</button>`
                      : `<button class="btn btn--ghost" data-action="resume-attempt" data-bank-id="${bank.id}" data-attempt-id="${attempt.id}">استكمال</button>`
                  }
                  <button class="btn btn--ghost" data-action="delete-attempt" data-bank-id="${bank.id}" data-attempt-id="${attempt.id}">حذف</button>
                </span>
              </div>
            `
                )
                .join("")
        }
      </div>
    </article>
  `;
}

function renderAttemptView() {
  const context = currentAttemptContext();
  if (!context) {
    return '<article class="card"><p class="status status--err">تعذر فتح المحاولة.</p></article>';
  }

  const { bank, attempt } = context;
  const total = bank.questions.length;
  const currentIndex = clamp(attempt.currentIndex, 0, total - 1);
  attempt.currentIndex = currentIndex;
  const question = bank.questions[currentIndex];

  const answered = countAnswered(attempt.answers, total);
  const progress = Math.round((answered / total) * 100);
  const answerKey = attempt.answers[String(currentIndex)] || "";

  const split = splitCount(bank.config.questionCount, bank.config.subjectMode, bank.config.verbalRatio);

  return `
    <section class="grid">
      <article class="card col-8">
        <div class="card__head">
          <div>
            <h2 class="card__title">${escapeHtml(bank.name)}</h2>
            <p class="card__sub">سؤال ${currentIndex + 1} من ${total} - ${SECTION_LABELS[question.source]} - ${escapeHtml(
    question.classification || "بدون تصنيف"
  )}</p>
          </div>
          <div class="row">
            <span class="pill">${SECTION_LABELS[bank.config.subjectMode]}</span>
            ${
              bank.config.subjectMode === "mixed"
                ? `<span class="pill pill--muted">لفظي ${split.verbal} / كمي ${split.quant}</span>`
                : ""
            }
          </div>
        </div>

        <div class="stack">
          <div>
            <p class="hint">المجاب: ${answered}/${total}</p>
            <div class="progress"><span style="width:${progress}%;"></span></div>
          </div>

          <article class="question-card">
            <p class="question-text">${asMultiline(question.question)}</p>
            <div class="choices">
              ${question.choices
                .map(
                  (choice) => `
                <button class="choice ${normalizeToken(answerKey) === normalizeToken(choice.key) ? "choice--selected" : ""}" data-action="attempt-select" data-key="${
                    choice.key
                  }">
                  <span class="choice__dot">${escapeHtml(choice.label || choice.key.toUpperCase())}</span>
                  <span>${asMultiline(choice.text)}</span>
                </button>
              `
                )
                .join("")}
            </div>
          </article>

          <div class="row row--middle">
            <button class="btn btn--secondary" data-action="attempt-prev" ${currentIndex === 0 ? "disabled" : ""}>السابق</button>
            <button class="btn btn--secondary" data-action="attempt-next" ${currentIndex === total - 1 ? "disabled" : ""}>التالي</button>
            <button class="btn btn--primary" data-action="attempt-submit">تسليم البنك</button>
          </div>
        </div>
      </article>

      <aside class="card col-4">
        <div class="card__head">
          <div>
            <h3 class="card__title">التنقل السريع</h3>
            <p class="card__sub">اختر رقم السؤال مباشرة</p>
          </div>
          <span class="pill pill--muted">${progress}%</span>
        </div>

        <div class="nav-grid">
          ${bank.questions
            .map((item, index) => {
              const answeredFlag = Boolean(attempt.answers[String(index)]);
              const classes = ["q-nav"];
              if (index === currentIndex) {
                classes.push("q-nav--active");
              } else if (answeredFlag) {
                classes.push("q-nav--done");
              }

              const label = item.source === "verbal" ? "ل" : "ك";
              return `<button class="${classes.join(" ")}" data-action="attempt-go" data-index="${index}">${index + 1}<small style="display:block;font-size:0.6rem;">${label}</small></button>`;
            })
            .join("")}
        </div>
      </aside>
    </section>
  `;
}

function renderSubmitOverlay() {
  const context = currentAttemptContext();
  if (!context) {
    return "";
  }

  const total = context.bank.questions.length;
  const answered = countAnswered(context.attempt.answers, total);
  const left = total - answered;

  return `
    <div class="overlay">
      <div class="overlay-card">
        <h3 style="margin-top:0;">تأكيد التسليم</h3>
        <p class="hint">تمت الإجابة على ${answered} من ${total}. ${left > 0 ? `متبقي ${left} سؤال بدون إجابة.` : "كل الأسئلة مجابة."}</p>
        <div class="row">
          <button class="btn btn--primary" data-action="confirm-submit">تأكيد التسليم</button>
          <button class="btn btn--secondary" data-action="cancel-submit">رجوع للمراجعة</button>
        </div>
      </div>
    </div>
  `;
}

function renderResultView() {
  const context = currentAttemptContext();
  if (!context) {
    return '<article class="card"><p class="status status--err">تعذر فتح النتيجة.</p></article>';
  }

  const { bank, attempt } = context;
  const total = bank.questions.length;
  const score = typeof attempt.score === "number" ? attempt.score : 0;
  const percent = total > 0 ? Math.round((score / total) * 100) : 0;

  return `
    <section class="stack">
      <article class="card">
        <div class="card__head">
          <div>
            <h2 class="card__title">نتيجة المحاولة</h2>
            <p class="card__sub">${escapeHtml(bank.name)}</p>
          </div>
          <span class="pill">${score} / ${total}</span>
        </div>

        <div class="row row--middle">
          <span class="pill pill--warm">${percent}%</span>
          <span class="pill pill--muted">المدة: ${formatDuration(attempt.durationSec || 0)}</span>
          <span class="pill pill--muted">${formatDate(attempt.startedAt)}</span>
        </div>

        <div class="row" style="margin-top: 12px;">
          <button class="btn btn--primary" data-action="start-new-attempt" data-bank-id="${bank.id}">محاولة جديدة لنفس البنك</button>
          <button class="btn btn--secondary" data-action="go-home">رجوع للبنوك</button>
        </div>
      </article>

      <article class="card">
        <div class="card__head">
          <div>
            <h3 class="card__title">المراجعة</h3>
            <p class="card__sub">إجابتك مقابل الإجابة الصحيحة</p>
          </div>
        </div>
        <div class="review-list">
          ${bank.questions.map((question, index) => renderReviewItem(question, attempt, index)).join("")}
        </div>
      </article>
    </section>
  `;
}

function renderReviewItem(question, attempt, index) {
  const answer = attempt.answers[String(index)] || "";
  const answerChoice = question.choices.find((choice) => normalizeToken(choice.key) === normalizeToken(answer));
  const correctChoice = question.choices.find((choice) => normalizeToken(choice.key) === normalizeToken(question.correctKey));
  const correct = normalizeToken(answer) && normalizeToken(answer) === normalizeToken(question.correctKey);

  return `
    <article class="review-item ${correct ? "review-item--ok" : "review-item--bad"}">
      <div class="row row--middle">
        <span class="pill">سؤال ${index + 1}</span>
        <span class="pill pill--muted">${SECTION_LABELS[question.source]}</span>
        <span class="pill ${correct ? "" : "pill--warm"}">${correct ? "صحيح" : "غير صحيح"}</span>
      </div>
      <p class="question-text">${asMultiline(question.question)}</p>
      <p class="hint">إجابتك: ${answerChoice ? `${escapeHtml(answerChoice.label)} - ${escapeHtml(answerChoice.text)}` : "لم تتم الإجابة"}</p>
      <p class="hint">الصحيح: ${correctChoice ? `${escapeHtml(correctChoice.label)} - ${escapeHtml(correctChoice.text)}` : "غير متوفر"}</p>
    </article>
  `;
}

function countAnswered(answers, total) {
  let answered = 0;
  for (let i = 0; i < total; i += 1) {
    if (answers[String(i)]) {
      answered += 1;
    }
  }
  return answered;
}

function formatDate(timestamp) {
  try {
    return new Intl.DateTimeFormat("ar-SA", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp));
  } catch (_error) {
    return String(timestamp);
  }
}

function formatDuration(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec));
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return `${min}د ${rest}ث`;
}

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
  }
  return arr;
}

function toText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function asMultiline(value) {
  return escapeHtml(normalizeRichText(value)).replaceAll("\n", "<br>");
}

function normalizeRichText(value) {
  const html = String(value || "").replace(/<br\s*\/?>/gi, "\n");
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return holder.textContent || "";
}
