/*
  Funcleson Brew Day Builder
  Working source file for the split app build.

  Maintenance intent for this cleanup pass:
  - keep behavior stable
  - make future edits faster and safer
  - centralize repeated recipe/batch/timer handoff logic
  - keep brewing math in scripts/brew-logic.js so UI edits stay isolated
  - add clear section markers so single-file-style drift does not return inside scripts/app.js
*/

    /* =========================================================
   Firebase module loading
   ========================================================= */

let initializeApp = null;
    let getAuth = null;
    let signInWithPopup = null;
    let GoogleAuthProvider = null;
    let onAuthStateChanged = null;
    let signOut = null;
    let getFirestore = null;
    let doc = null;
    let getDoc = null;
    let setDoc = null;

    async function loadFirebaseModules(){
      if (initializeApp && getAuth && getFirestore) return true;
      try{
        const [appMod, authMod, fsMod] = await Promise.all([
          import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js"),
          import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js"),
          import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js")
        ]);
        initializeApp = appMod.initializeApp;
        getAuth = authMod.getAuth;
        signInWithPopup = authMod.signInWithPopup;
        GoogleAuthProvider = authMod.GoogleAuthProvider;
        onAuthStateChanged = authMod.onAuthStateChanged;
        signOut = authMod.signOut;
        getFirestore = fsMod.getFirestore;
        doc = fsMod.doc;
        getDoc = fsMod.getDoc;
        setDoc = fsMod.setDoc;
        return true;
      } catch(error){
        console.error("Firebase module load failed:", error);
        return false;
      }
    }
    /* =========================================================
   App constants and shared defaults
   ========================================================= */

const STORAGE_KEY = "funcleson-brewday-v5";
    const LEGACY_STORAGE_KEYS = ["funcleson-brewday-v4","funcleson-brewday-v3"];
    const TIMER_KEYS = ["mash","boil","adjunct","custom"];
    const BREWDAY_STAGES = new Set(["OG","Pre-Boil","Post-Boil"]);
    const FIREBASE_COLLECTION = "funclesonBrewdayUsers";
    const firebaseConfig = {
  apiKey: "AIzaSyCE1MfVVCA5t2f74T3FIORuXoEuj8ZpL6U",
  authDomain: "funcleapp.firebaseapp.com",
  projectId: "funcleapp",
  storageBucket: "funcleapp.firebasestorage.app",
  messagingSenderId: "207986521450",
  appId: "1:207986521450:web:f0c516aef3a40eabd1e113",
  measurementId: "G-8LZZLNNDNR"
};

    const BrewLogicApi = window.BrewLogic || {};
    const {
      convertToPounds,
      formatWeightLb,
      calculateBiabPlan,
      calcABV,
      calcPoints,
      calcAttenuation,
      estimateTinsethIBU,
      estimateMoreySRM,
      srmToColor,
      calculatePrimingSugarCorn,
      calculateStarterRecommendation,
      calculateBottleCount,
      calculateKegPressure
    } = BrewLogicApi;


    let firebaseAppInstance = null;
    let firebaseAuth = null;
    let firebaseDb = null;
    let currentUser = null;
    let firebaseEnabled = false;
    let appBooted = false;
    let tickIntervalId = null;
    let saveTimerId = null;
    let saveQueued = false;
    let saveInFlight = false;
    let authListenerBound = false;
    let manualLocalMode = false;

    /* ── Audio + Notification system (Fix 1 & 2) ─────────────────── */
    const _audioCtx = (function(){
      let ctx = null;
      function get(){
        if (!ctx) try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e){}
        return ctx;
      }
      return { get };
    })();

    function playTimerChime(){
      const ctx = _audioCtx.get();
      if (!ctx) return;
      if (ctx.state === "suspended") ctx.resume();
      const notes = [659.25, 783.99, 987.77]; // E5, G5, B5 — bright arpeggio
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.18, ctx.currentTime + i * 0.15);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.15);
        osc.stop(ctx.currentTime + i * 0.15 + 0.55);
      });
    }

    function playUrgentTone(){
      const ctx = _audioCtx.get();
      if (!ctx) return;
      if (ctx.state === "suspended") ctx.resume();
      [880, 880].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.10, ctx.currentTime + i * 0.25);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.25 + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.25);
        osc.stop(ctx.currentTime + i * 0.25 + 0.2);
      });
    }

    function requestNotificationPermission(){
      if ("Notification" in window && Notification.permission === "default"){
        Notification.requestPermission();
      }
    }

    function sendTimerNotification(label){
      playTimerChime();
      if ("vibrate" in navigator) try { navigator.vibrate([200, 100, 200]); } catch(e){}
      if ("Notification" in window && Notification.permission === "granted"){
        try { new Notification("Funcleson Brew Works", { body: `${label} timer finished.`, icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍺</text></svg>" }); } catch(e){}
      }
    }
    /* ── end audio/notification ───────────────────────────────────── */
    /* =========================================================
   Recipe section defaults and normalization helpers
   ========================================================= */

const RECIPE_SECTION_DEFAULTS = {
      fermentables: [{ name:"", amount:"", unit:"lb", lovibond:"", percent:"" }],
      hops: [{ name:"", amount:"", unit:"oz", time:"60", use:"Boil" }],
      yeast: [{ name:"", amount:"", unit:"packet", timing:"" }],
      otherIngredients: [{ name:"", amount:"", unit:"", timing:"" }],
      mashGuidelines: { temp:"", time:"", boilTime:"", boilOff:"", trub:"", absorption:"", grainTemp:"", ratio:"", spargeTemp:"", notes:"" },
      defaults: { schedule: [], timers: {}, packaging: null }
    };

    function defaultRecipeSections(){
      return clone(RECIPE_SECTION_DEFAULTS);
    }

    const $ = (id) => document.getElementById(id);
    const todayStr = () => new Date().toISOString().slice(0,10);

    function normalizeDecimalInput(value){
      return String(value ?? "").replace(/,/g, ".").replace(/[^0-9.]/g, "");
    }

    function parseMaybeDecimal(value){
      const cleaned = normalizeDecimalInput(value);
      if (!cleaned) return NaN;
      const first = cleaned.indexOf(".");
      const normalized = first === -1 ? cleaned : cleaned.slice(0, first + 1) + cleaned.slice(first + 1).replace(/\./g, "");
      return Number(normalized);
    }

    function bindDecimalField(id){
      const el = $(id);
      if (!el) return;
      el.addEventListener("input", () => {
        const raw = String(el.value ?? "").replace(/,/g, ".").replace(/[^0-9.]/g, "");
        const first = raw.indexOf(".");
        el.value = first === -1 ? raw : raw.slice(0, first + 1) + raw.slice(first + 1).replace(/\./g, "");
      });
    }

    function escapeHTML(value){
      return String(value ?? "")
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;")
        .replaceAll("'","&#39;");
    }

    function clone(x){
      return JSON.parse(JSON.stringify(x));
    }

    function normalizeRecipeSections(sections){
      const merged = { ...defaultRecipeSections(), ...(sections || {}) };
      const mapRows = (rows, fallback) => (Array.isArray(rows) && rows.length ? rows : fallback).map((row) => ({ ...row }));
      merged.fermentables = mapRows(merged.fermentables, defaultRecipeSections().fermentables);
      merged.hops = mapRows(merged.hops, defaultRecipeSections().hops);
      merged.yeast = mapRows(merged.yeast, defaultRecipeSections().yeast);
      merged.otherIngredients = mapRows(merged.otherIngredients, defaultRecipeSections().otherIngredients);
      merged.mashGuidelines = { ...defaultRecipeSections().mashGuidelines, ...(merged.mashGuidelines || {}) };
      merged.defaults = { ...defaultRecipeSections().defaults, ...(merged.defaults || {}) };
      return merged;
    }


    function buildBiabPlan(sections, volumeValue){
      const normalized = normalizeRecipeSections(sections);
      const mash = normalized.mashGuidelines || {};
      const batchSize = parseMaybeDecimal(volumeValue);
      const grainLb = normalized.fermentables.reduce((sum, row) => sum + convertToPounds(row.amount, row.unit), 0);
      return calculateBiabPlan({
        batchSize,
        grainLb,
        mashTemp: parseMaybeDecimal(mash.temp),
        mashTime: parseMaybeDecimal(mash.time),
        boilTime: parseMaybeDecimal(mash.boilTime),
        boilOffRate: parseMaybeDecimal(mash.boilOff),
        trub: parseMaybeDecimal(mash.trub),
        absorption: parseMaybeDecimal(mash.absorption),
        grainTemp: parseMaybeDecimal(mash.grainTemp),
        notes: mash.notes || ""
      });
    }

    function renderBiabPlanHtml(plan){
      if (!plan || !plan.hasPlan){
        return `<div class="empty-state">Load a recipe with BIAB planning fields and fermentables to see strike temp, total water, and brew-day targets here.</div>`;
      }
      const rows = [
        ["Batch size", plan.batchSize != null ? `${plan.batchSize.toFixed(2)} gal` : "—"],
        ["Grain bill", plan.grainLb != null ? formatWeightLb(plan.grainLb) : "—"],
        ["Mash thickness", plan.ratio != null ? `${plan.ratio.toFixed(2)} qt/lb` : "—"],
        ["Mash volume", plan.mashVolume != null ? `${plan.mashVolume.toFixed(2)} gal` : "—"],
        ["Total water", plan.totalWater != null ? `${plan.totalWater.toFixed(2)} gal` : "—"],
        ["Pre-boil volume", plan.preBoilVol != null ? `${plan.preBoilVol.toFixed(2)} gal` : "—"],
        ["Strike temp", plan.strikeTemp != null ? `${plan.strikeTemp.toFixed(1)}°F` : "—"],
        ["Mash time", plan.mashTime != null ? `${plan.mashTime.toFixed(0)} min` : "—"],
        ["Boil time", plan.boilTime != null ? `${plan.boilTime.toFixed(0)} min` : "—"],
        ["Boiloff", plan.boilOffRate != null ? `${plan.boilOffRate.toFixed(2)} gal/hr` : "—"],
        ["Trub", plan.trub != null ? `${plan.trub.toFixed(2)} gal` : "—"],
        ["Absorption", plan.absorption != null ? `${plan.absorption.toFixed(3)} gal/lb` : "—"]
      ];
      return `
        <div class="info-rows">
          ${rows.map(([label, value]) => `<div class="info-row"><div class="info-row-label">${escapeHTML(label)}</div><div class="info-row-value"><strong style="color:var(--cream)">${escapeHTML(value)}</strong></div></div>`).join("")}
        </div>
        ${plan.notes ? `<div class="notes-box" style="margin-top:12px">${escapeHTML(plan.notes).replace(/\n/g, "<br>")}</div>` : ""}
      `;
    }

    function buildIngredientsTextFromSections(sections){
      const s = normalizeRecipeSections(sections);
      const chunk = [];
      const addRows = (title, rows, formatter) => {
        const cleaned = rows.map(formatter).filter(Boolean);
        if (cleaned.length){
          chunk.push(title);
          chunk.push(...cleaned.map((line) => `- ${line}`));
          chunk.push("");
        }
      };
      addRows("Fermentables", s.fermentables, (row) => row.name ? `${row.name} — ${row.amount || "—"} ${row.unit || ""}${row.lovibond ? ` · ${row.lovibond}°L` : ""}${row.percent ? ` · ${row.percent}%` : ""}` : "");
      addRows("Hops", s.hops, (row) => row.name ? `${row.name}${row.aa ? ` (${row.aa}% AA)` : ""} — ${row.amount || "—"} ${row.unit || ""}${row.time ? ` @ ${row.time}` : ""}${row.use ? ` · ${row.use}` : ""}` : "");
      addRows("Yeast", s.yeast, (row) => row.name ? `${row.name} — ${row.amount || "—"} ${row.unit || ""}` : "");
      addRows("Other ingredients", s.otherIngredients, (row) => row.name ? `${row.name} — ${row.amount || "—"} ${row.unit || ""}${row.timing ? ` · ${row.timing}` : ""}` : "");
      const mash = s.mashGuidelines || {};
      const mashLines = [
        mash.temp ? `Mash temp: ${mash.temp}°F` : "",
        mash.time ? `Mash time: ${mash.time} min` : "",
        mash.boilTime ? `Boil time: ${mash.boilTime} min` : "",
        mash.boilOff ? `Boiloff: ${mash.boilOff} gal/hr` : "",
        mash.trub ? `Trub loss: ${mash.trub} gal` : "",
        mash.absorption ? `Grain absorption: ${mash.absorption} gal/lb` : "",
        mash.grainTemp ? `Grain temp: ${mash.grainTemp}°F` : "",
        mash.ratio ? `Legacy water ratio: ${mash.ratio} qt/lb` : "",
        mash.spargeTemp ? `Legacy sparge temp: ${mash.spargeTemp}°F` : "",
        mash.notes ? `Notes: ${mash.notes}` : ""
      ].filter(Boolean);
      if (mashLines.length){
        chunk.push("BIAB brew plan");
        chunk.push(...mashLines.map((line) => `- ${line}`));
      }
      return chunk.join("\n").trim();
    }

    function recipeSectionsSummary(sections){
      const s = normalizeRecipeSections(sections);
      return {
        fermentables: s.fermentables.filter((row) => row.name).length,
        hops: s.hops.filter((row) => row.name).length,
        yeast: s.yeast.filter((row) => row.name).length,
        other: s.otherIngredients.filter((row) => row.name).length
      };
    }

    function makeId(prefix){
      return prefix + "-" + Math.random().toString(36).slice(2,10) + "-" + Date.now().toString(36);
    }

    /* =========================================================
   Persistent application state shape
   ========================================================= */

const defaultData = {
      activeTab: "dashboard",
      ui: {
        gravityFilter: "all",
        scheduleSync: true,
        archiveQuery: "",
        archiveFilter: "all",
        recipeQuery: "",
        recipeTypeFilter: "all",
        recipeSort: "recent",
        editingRecipeId: null,
        layoutVersion: "v9",
        compactMode: true,
        dashboardWidgets: {
          stats: true,
          batch: true,
          urgent: true,
          timers: true,
          gravity: true,
          finish: true,
          activeBatches: false,
          ai: false
        }
      },
      currentBatch: {
        name: "",
        style: "",
        type: "Beer",
        volume: "",
        og: "",
        fg: "",
        abv: "",
        notes: "",
        ingredients: "",
        process: "",
        sourceRecipeId: "",
        biab: null
      },
      brewMate: {
        conceptName: "",
        style: "",
        inspiration: "",
        vision: "",
        batchSize: "",
        abv: "",
        ibu: "",
        bitterness: "balanced",
        body: "medium",
        finish: "balanced",
        yeast: "clean",
        drinkability: "balanced",
        experimental: "modern",
        mustHave: "",
        avoid: "",
        adjuncts: "",
        constraints: "",
        lessonFocus: "balance"
      },
      waterChem: {
        gypsum: "", cacl2: "", epsom: "", lactic: "", phospho: "", mashpH: "", notes: ""
      },
      brewElapsed: {
        startedAt: null,
        running: false
      },
      activeBatches: [],
      checklists: {
        beer: [
          { text: "Heat strike water", done: false },
          { text: "Mash in and confirm mash temp", done: false },
          { text: "Set mash timer", done: false },
          { text: "Recirculate / stir as needed", done: false },
          { text: "Lift the bag and drain thoroughly", done: false },
          { text: "Bring to boil and set boil timer", done: false },
          { text: "Add bittering hops / boil additions", done: false },
          { text: "Add late hops / kettle finings / adjuncts", done: false },
          { text: "Chill to pitch temp", done: false },
          { text: "Take OG and record pre-pitch notes", done: false },
          { text: "Pitch yeast and set fermentation plan", done: false },
          { text: "Clean the kettle before future-you gets angry", done: false }
        ]
      },
      activeChecklistType: "beer",
      timers: {
        mash: { initial: 3600, remaining: 3600, running: false, lastStarted: null, finishedAt: null },
        boil: { initial: 3600, remaining: 3600, running: false, lastStarted: null, finishedAt: null },
        adjunct: { initial: 900, remaining: 900, running: false, lastStarted: null, finishedAt: null },
        custom: { initial: 600, remaining: 600, running: false, lastStarted: null, finishedAt: null }
      },
      gravityLog: [],
      schedule: [],
      recipes: [],
      selectedRecipeId: null,
      packaging: {
        type: "bottling",
        checklists: {
          bottling: [
            { text: "Confirm FG is stable", done: false },
            { text: "Sanitize bottles / wand / bucket", done: false },
            { text: "Prepare priming sugar solution", done: false },
            { text: "Rack gently to bottling bucket", done: false },
            { text: "Mix priming solution evenly", done: false },
            { text: "Fill and cap bottles", done: false },
            { text: "Label batch and date", done: false },
            { text: "Store warm for carbonation", done: false }
          ],
          kegging: [
            { text: "Confirm FG is stable", done: false },
            { text: "Clean and sanitize keg", done: false },
            { text: "Purge keg with CO₂", done: false },
            { text: "Transfer with minimal oxygen pickup", done: false },
            { text: "Seal and pressure test", done: false },
            { text: "Set serving or burst carb pressure", done: false },
            { text: "Label keg with batch/date", done: false }
          ]
        },
        notes: "",
        tastingNotes: "",
        rating: "",
        wouldBrewAgain: false,
        tags: ""
      },
      archive: []
    };

    function normalizeData(parsed){
      const merged = {
        ...clone(defaultData),
        ...parsed,
        ui: { ...clone(defaultData.ui), ...(parsed.ui || {}) },
        currentBatch: { ...clone(defaultData.currentBatch), ...(parsed.currentBatch || {}) },
        brewMate: { ...clone(defaultData.brewMate), ...(parsed.brewMate || {}) },
        waterChem: { ...clone(defaultData.waterChem), ...(parsed.waterChem || parsed.waterChemistry || {}) },
        waterChemistry: { ...clone(defaultData.waterChem), ...(parsed.waterChemistry || parsed.waterChem || {}) },
        brewElapsed: { ...clone(defaultData.brewElapsed), ...(parsed.brewElapsed || parsed.brewTimer || {}) },
        checklists: { ...clone(defaultData.checklists), beer: parsed.checklists?.beer || clone(defaultData.checklists.beer) },
        timers: { ...clone(defaultData.timers), ...(parsed.timers || {}) },
        packaging: {
          ...clone(defaultData.packaging),
          ...(parsed.packaging || {}),
          checklists: {
            ...clone(defaultData.packaging.checklists),
            ...((parsed.packaging || {}).checklists || {})
          }
        }
      };

      merged.activeChecklistType = "beer";

      merged.gravityLog = (Array.isArray(parsed.gravityLog) ? parsed.gravityLog : clone(defaultData.gravityLog)).map((entry) => ({
        id: entry.id || makeId("grav"),
        date: entry.date || todayStr(),
        gravity: Number(entry.gravity) || "",
        stage: entry.stage || "Fermentation",
        note: entry.note || "",
        temp: entry.temp || "",
        createdAt: entry.createdAt || new Date().toISOString()
      }));

      merged.schedule = (Array.isArray(parsed.schedule) ? parsed.schedule : clone(defaultData.schedule)).map((entry) => ({
        id: entry.id || makeId("sched"),
        minutesLeft: Number(entry.minutesLeft) || 0,
        item: entry.item || "",
        note: entry.note || ""
      })).filter((entry) => entry.minutesLeft >= 0 && entry.item);

      merged.recipes = (Array.isArray(parsed.recipes) ? parsed.recipes : []).map((item) => {
        const sections = normalizeRecipeSections(item.sections);
        return {
          id: item.id || makeId("recipe"),
          name: item.name || "",
          style: item.style || "",
          type: item.type || "Beer",
          volume: item.volume || "",
          og: item.og || "",
          fg: item.fg || "",
          abv: item.abv || computedAbvValue(item.og, item.fg) || "",
          notes: item.notes || "",
          quick: item.quick || item.notes || "",
          ingredients: item.ingredients || buildIngredientsTextFromSections(sections),
          process: item.process || "",
          tags: Array.isArray(item.tags) ? item.tags : [],
          sections
        };
      });

      merged.archive = (Array.isArray(parsed.archive) ? parsed.archive : []).map((item) => ({
        id: item.id || makeId("arch"),
        date: item.date || todayStr(),
        name: item.name || "",
        style: item.style || "",
        type: item.type || "",
        volume: item.volume || "",
        og: item.og || "",
        fg: item.fg || "",
        abv: item.abv || "",
        notes: item.notes || "",
        ingredients: item.ingredients || "",
        process: item.process || "",
        packagingNotes: item.packagingNotes || "",
        tastingNotes: item.tastingNotes || "",
        rating: item.rating || "",
        wouldBrewAgain: Boolean(item.wouldBrewAgain),
        tags: item.tags || ""
      }));

      TIMER_KEYS.forEach((key) => {
        const t = merged.timers[key];
        t.initial = Number(t.initial) || clone(defaultData.timers[key].initial);
        t.remaining = Number(t.remaining) || t.initial;
        t.running = Boolean(t.running);
        t.lastStarted = t.lastStarted || null;
        t.finishedAt = t.finishedAt || null;
      });

      if (!["all","brewday","fermentation"].includes(merged.ui.gravityFilter)) merged.ui.gravityFilter = "all";
      if (typeof merged.ui.scheduleSync !== "boolean") merged.ui.scheduleSync = true;
      if (typeof merged.ui.archiveQuery !== "string") merged.ui.archiveQuery = "";
      if (!["all","brew-again"].includes(merged.ui.archiveFilter)) merged.ui.archiveFilter = "all";
      if (typeof merged.ui.editingRecipeId !== "string") merged.ui.editingRecipeId = null;
      if (merged.ui.layoutVersion !== "v8"){
        merged.activeTab = merged.currentBatch && (merged.currentBatch.name || merged.currentBatch.style || merged.currentBatch.notes || merged.currentBatch.ingredients) ? "brewday" : "recipes";
        merged.ui.layoutVersion = "v9";
      }
      merged.waterChemistry = { ...(merged.waterChemistry || merged.waterChem || clone(defaultData.waterChem)) };
      merged.waterChem = { ...(merged.waterChem || merged.waterChemistry || clone(defaultData.waterChem)) };
      if (!["dashboard","brewday","timers","recipes","archive","packaging","math"].includes(merged.activeTab)) merged.activeTab = merged.currentBatch && (merged.currentBatch.name || merged.currentBatch.style || merged.currentBatch.notes || merged.currentBatch.ingredients) ? "brewday" : "recipes";

      return merged;
    }

    /* =========================================================
   Local persistence bootstrapping
   ========================================================= */

function loadData(){
      const candidates = [STORAGE_KEY, ...LEGACY_STORAGE_KEYS];
      for (const key of candidates){
        try{
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          return normalizeData(JSON.parse(raw));
        } catch(error){}
      }
      return normalizeData(clone(defaultData));
    }

    
    let data = loadData();

    let _dashRenderTimer = null;
    function setBodyLock(locked){
      document.body.classList.toggle("app-locked", !!locked);
    }

    function isFirebaseConfigFilled(){
      return Object.values(firebaseConfig).every((value) => value && !String(value).includes("YOUR_"));
    }

    /* =========================================================
   Auth gate and cloud/local sync status
   ========================================================= */

function updateSyncStatus(label = "Local", state = "idle"){
      const pill = $("syncStatus");
      const text = $("syncStatusText");
      if (!pill || !text) return;
      pill.classList.remove("ready","saving","error");
      if (state === "ready") pill.classList.add("ready");
      if (state === "saving") pill.classList.add("saving");
      if (state === "error") pill.classList.add("error");
      text.textContent = label;
    }

    function setAuthGate(mode, detail = ""){
      const title = $("authTitle");
      const message = $("authMessage");
      const note = $("authNote");
      const signInBtn = $("googleSignInBtn");
      const retryBtn = $("retryFirebaseBtn");

      if (signInBtn) signInBtn.style.display = "none";
      if (retryBtn) retryBtn.style.display = "none";

      if (mode === "hidden"){
        setBodyLock(false);
        return;
      }

      setBodyLock(true);

      if (mode === "loading"){
        title.innerHTML = '<span class="loading-spinner"></span>Loading FuncleApp…';
        message.textContent = detail || "Checking sign-in and loading your brew data.";
        note.textContent = "";
      } else if (mode === "signedout"){
        title.textContent = "Open FuncleApp";
        message.textContent = detail || "Sign in with Google to load your saved brew data.";
        note.textContent = "Need to test layout or recipes without Firebase? Use local-only mode below.";
        signInBtn.style.display = "inline-flex";
      } else if (mode === "config"){
        title.textContent = "Firebase setup needed";
        message.textContent = detail || "Firebase did not initialize. Check your config and redeploy.";
        note.textContent = "You can still open the app in local-only mode to test the interface and recipe workflow.";
        retryBtn.style.display = "inline-flex";
      } else if (mode === "error"){
        title.textContent = "Firebase connection problem";
        message.textContent = detail || "Google sign-in is not ready yet. Check your config, authorized domain, and Google provider settings.";
        note.textContent = "You can still open the app in local-only mode for UI testing and recipe work without waiting on Firebase.";
        retryBtn.style.display = "inline-flex";
      }
    }

    function updateUserUi(){
      const chip = $("userChip");
      const signOutBtn = $("signOutBtn");
      if (chip){
        if (currentUser){
          chip.hidden = false;
          chip.textContent = currentUser.displayName || currentUser.email || "Signed in";
        } else {
          chip.hidden = true;
          chip.textContent = "";
        }
      }
      if (signOutBtn) signOutBtn.hidden = !currentUser;
    }

    function cacheLocalData(){
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }

    async function writeCloudData(){
      if (!firebaseEnabled || !firebaseDb || !currentUser || manualLocalMode) return;
      if (saveInFlight){
        saveQueued = true;
        return;
      }
      saveInFlight = true;
      updateSyncStatus("Saving…", "saving");
      try{
        data.waterChemistry = { ...(data.waterChemistry || data.waterChem || {}) };
        data.waterChem = { ...(data.waterChem || data.waterChemistry || {}) };
        const payload = clone(data);
        await setDoc(doc(firebaseDb, FIREBASE_COLLECTION, currentUser.uid), {
          data: payload,
          updatedAt: new Date().toISOString(),
          uid: currentUser.uid,
          email: currentUser.email || "",
          displayName: currentUser.displayName || ""
        }, { merge: true });
        updateSyncStatus("Synced", "ready");
      } catch(error){
        console.error("Cloud save failed:", error);
        updateSyncStatus("Sync error", "error");
      } finally {
        saveInFlight = false;
        if (saveQueued){
          saveQueued = false;
          writeCloudData();
        }
      }
    }

    function queueCloudSave(){
      if (!firebaseEnabled || !currentUser || manualLocalMode) return;
      if (saveTimerId) clearTimeout(saveTimerId);
      saveTimerId = setTimeout(() => {
        saveTimerId = null;
        writeCloudData();
      }, 450);
    }

    function saveData(){
      data.waterChemistry = { ...(data.waterChemistry || data.waterChem || {}) };
      data.waterChem = { ...(data.waterChem || data.waterChemistry || {}) };
      cacheLocalData();
      queueCloudSave();
      if (document.getElementById("dashboardStats")){
        if (_dashRenderTimer) clearTimeout(_dashRenderTimer);
        _dashRenderTimer = setTimeout(() => { _dashRenderTimer = null; renderDashboard(); }, 300);
      }
    }
    const persistData = saveData;


    function formatSeconds(totalSeconds){
      const seconds = Math.max(0, Math.floor(totalSeconds || 0));
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${String(mins).padStart(2,"0")}:${String(secs).padStart(2,"0")}`;
    }

    /* =========================================================
   Brewing math and derived values
   ========================================================= */


    function computedAbvValue(og, fg){
      const abv = calcABV(og, fg);
      return abv == null ? "" : Number(abv.toFixed(2));
    }

    function syncBatchAbvField(){
      const abv = computedAbvValue($("batchOG").value, $("batchFG").value);
      $("batchABV").value = abv === "" ? "" : abv.toFixed(2);
      return abv;
    }

    function syncRecipeAbvField(){
      const abv = computedAbvValue($("templateOG").value, $("templateFG").value);
      $("templateABV").value = abv === "" ? "" : abv.toFixed(2);
      return abv;
    }


    /* Shared batch-handoff helpers keep recipe -> brew day and archive -> brew day
       using the same field map so future edits only need one change point. */
    function buildCurrentBatchFromRecipe(recipe, normalizedSections = normalizeRecipeSections(recipe.sections), biabPlan = buildBiabPlan(normalizedSections, recipe.volume || "")){
      return {
        ...clone(defaultData.currentBatch),
        name: recipe.name || "",
        style: recipe.style || "",
        type: recipe.type || "Beer",
        volume: recipe.volume || "",
        og: recipe.og || "",
        fg: recipe.fg || "",
        abv: computedAbvValue(recipe.og, recipe.fg) || recipe.abv || "",
        notes: recipe.notes || recipe.quick || "",
        ingredients: buildIngredientsTextFromSections(normalizedSections) || recipe.ingredients || "",
        process: recipe.process || "",
        sourceRecipeId: recipe.id || "",
        biab: biabPlan || null
      };
    }

    function buildCurrentBatchFromArchiveItem(item){
      return {
        ...clone(defaultData.currentBatch),
        name: item.name || "",
        style: item.style || "",
        type: item.type || "Beer",
        volume: item.volume || "",
        og: item.og || "",
        fg: item.fg || "",
        abv: item.abv || computedAbvValue(item.og, item.fg) || "",
        notes: item.notes || "",
        ingredients: item.ingredients || "",
        process: item.process || "",
        sourceRecipeId: item.sourceRecipeId || "",
        biab: item.biabPlan ? clone(item.biabPlan) : null
      };
    }


    /* =========================================================
   Timer state helpers
   ========================================================= */

function getTimerRemaining(timer){
      if (!timer.running || !timer.lastStarted) return Math.max(0, Number(timer.remaining) || 0);
      const elapsed = Math.floor((Date.now() - new Date(timer.lastStarted).getTime()) / 1000);
      return Math.max(0, (Number(timer.remaining) || 0) - elapsed);
    }


    function resetTimerRuntime(timer, nextRemaining = timer.initial){
      timer.remaining = Math.max(0, Math.round(Number(nextRemaining) || 0));
      timer.running = false;
      timer.lastStarted = null;
      timer.finishedAt = null;
    }

    function applyTimerPreset(key, totalSeconds){
      const timer = data.timers[key];
      const safeSeconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
      if (!timer || !safeSeconds) return;
      timer.initial = safeSeconds;
      resetTimerRuntime(timer, safeSeconds);
    }

    function applyTimerDefaultsFromMap(timerDefaults = {}){
      TIMER_KEYS.forEach((key) => {
        if (timerDefaults[key] && timerDefaults[key].initial){
          applyTimerPreset(key, Number(timerDefaults[key].initial));
        }
      });
    }

    function applyBiabTimerFallbacks(biabPlan, timerDefaults = {}){
      const hasMashTimerDefault = Boolean(timerDefaults.mash && timerDefaults.mash.initial);
      const hasBoilTimerDefault = Boolean(timerDefaults.boil && timerDefaults.boil.initial);
      if (!hasMashTimerDefault && biabPlan && biabPlan.mashTime > 0){
        applyTimerPreset("mash", Number(biabPlan.mashTime) * 60);
      }
      if (!hasBoilTimerDefault && biabPlan && biabPlan.boilTime > 0){
        applyTimerPreset("boil", Number(biabPlan.boilTime) * 60);
      }
    }

    function pauseTimer(key){
      const timer = data.timers[key];
      if (!timer.running) return;
      timer.remaining = getTimerRemaining(timer);
      timer.running = false;
      timer.lastStarted = null;
      persistData();
    }

    function startTimer(key){
      const timer = data.timers[key];
      if (getTimerRemaining(timer) <= 0){
        timer.remaining = timer.initial;
        timer.finishedAt = null;
      }
      if (timer.running) return;
      timer.running = true;
      timer.lastStarted = new Date().toISOString();
      timer.finishedAt = null;
      requestNotificationPermission();
      _audioCtx.get(); // warm up audio context on user gesture
      persistData();
    }

    function resetTimer(key){
      const timer = data.timers[key];
      resetTimerRuntime(timer, timer.initial);
      persistData();
      renderTimers();
      renderSchedule();
      renderBoilSnapshot();
      renderStickyTimerDock();
    }

    function adjustTimer(key, deltaSeconds){
      const timer = data.timers[key];
      const current = getTimerRemaining(timer);
      timer.remaining = Math.max(0, current + deltaSeconds);
      timer.finishedAt = null;
      if (timer.running){
        timer.lastStarted = new Date().toISOString();
      } else if (timer.remaining > timer.initial && deltaSeconds > 0){
        timer.initial = timer.remaining;
      }
      persistData();
      renderTimers();
      renderSchedule();
      renderBoilSnapshot();
      renderStickyTimerDock();
    }

    function applyTimerDuration(key){
      const input = $(`${key}Duration`);
      if (!input) return;
      const minutes = Number(input.value);
      if (!minutes || minutes < 1){
        input.value = Math.round(data.timers[key].initial / 60);
        return;
      }
      applyTimerPreset(key, Math.round(minutes * 60));
      persistData();
      renderTimers();
      renderSchedule();
      renderBoilSnapshot();
      renderStickyTimerDock();
    }

    function finishRunningTimers(){
      let changed = false;
      for (const key of TIMER_KEYS){
        const timer = data.timers[key];
        if (!timer.running) continue;
        if (getTimerRemaining(timer) <= 0){
          timer.remaining = 0;
          timer.running = false;
          timer.lastStarted = null;
          if (!timer.finishedAt){
            timer.finishedAt = new Date().toISOString();
            changed = true;
            sendTimerNotification(key.charAt(0).toUpperCase() + key.slice(1));
          }
        }
      }
      if (changed) persistData();
    }

    function getCurrentBoilMinutesLeft(){
      return Math.ceil(getTimerRemaining(data.timers.boil) / 60);
    }

    function sortedSchedule(){
      return [...data.schedule].sort((a,b) => b.minutesLeft - a.minutesLeft);
    }

    function getScheduleDecorated(){
      const items = sortedSchedule();
      if (!items.length) return [];

      const boilMinutes = getCurrentBoilMinutesLeft();
      const syncOn = data.ui.scheduleSync;
      const upcoming = items
        .map(item => ({ item, untilDue: boilMinutes - item.minutesLeft }))
        .filter(entry => entry.untilDue >= 0)
        .sort((a,b) => a.untilDue - b.untilDue);
      const nextUpcomingId = upcoming[0] ? upcoming[0].item.id : null;

      return items.map((item) => {
        if (!syncOn){
          return { ...item, statusLabel: "Scheduled", rowClass: "", detailLabel: `${item.minutesLeft} min left` };
        }

        const untilDue = boilMinutes - item.minutesLeft;
        let statusLabel = "Later";
        let rowClass = "";

        if (untilDue < -1){
          statusLabel = "Overdue";
          rowClass = "overdue";
        } else if (Math.abs(untilDue) <= 1){
          statusLabel = "Due now";
          rowClass = "now";
        } else if (untilDue >= 2 && untilDue <= 5){
          statusLabel = "Soon";
          rowClass = "soon";
        } else if (item.id === nextUpcomingId){
          statusLabel = "Next up";
          rowClass = "next";
        }

        const detailLabel = untilDue < 0
          ? `${Math.abs(untilDue)} min late`
          : untilDue === 0
            ? "Now"
            : `In ${untilDue} min`;

        return { ...item, statusLabel, rowClass, detailLabel, untilDue };
      });
    }

    function getGravityCategory(stage){
      return BREWDAY_STAGES.has(stage) ? "brewday" : "fermentation";
    }

    function sortedGravityLog(){
      return [...data.gravityLog].sort((a,b) => new Date(b.createdAt || b.date).getTime() - new Date(a.createdAt || a.date).getTime());
    }

    function filteredGravityLog(){
      const filter = data.ui.gravityFilter;
      if (filter === "all") return sortedGravityLog();
      return sortedGravityLog().filter((entry) => getGravityCategory(entry.stage) === filter);
    }

    function getActualOg(){
      const ogEntry = sortedGravityLog().find((entry) => entry.stage === "OG");
      return ogEntry ? Number(ogEntry.gravity) : Number(data.currentBatch.og) || null;
    }

    function gravityTrendData(){
      const ordered = [...filteredGravityLog()].reverse();
      return ordered.filter((entry) => entry.gravity);
    }

    function setActiveTab(tab){
      data.activeTab = tab;
      document.querySelectorAll(".tab-btn").forEach((btn) => {
        const isActive = btn.dataset.tab === tab;
        btn.classList.toggle("active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === "tab-" + tab));
      persistData();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function renderBatchInputs(){
      const b = data.currentBatch;
      $("batchName").value = b.name ?? "";
      $("batchStyle").value = b.style ?? "";
      $("batchType").value = b.type ?? "Beer";
      $("batchVolume").value = b.volume ?? "";
      $("batchOG").value = b.og ?? "";
      $("batchFG").value = b.fg ?? "";
      const computedBatchAbv = computedAbvValue(b.og, b.fg);
      if (computedBatchAbv !== "") b.abv = computedBatchAbv;
      $("batchABV").value = computedBatchAbv !== "" ? computedBatchAbv.toFixed(2) : (b.abv ?? "");
      $("recipeIngredients").value = b.ingredients ?? "";
      $("recipeProcess").value = b.process ?? "";
      $("batchNotes").value = b.notes ?? "";

      const est = calcABV(b.og, b.fg);
      const pts = calcPoints(b.og, b.fg);
      const summary = $("currentBatchSummaryCard");
      const quick = $("brewdayQuickActions");
      const biabSnapshot = $("brewdayBiabSnapshot");
      const schedule = getScheduleDecorated();
      const dueNow = schedule.filter((row) => row.statusLabel === "Due now");
      const nextUp = schedule.find((row) => row.statusLabel === "Next up") || schedule.find((row) => row.statusLabel === "Soon");
      const packagingList = data.packaging.checklists[data.packaging.type] || [];
      const packagingDone = packagingList.filter((item) => item.done).length;
      if (summary){
        if (!b.name){
          summary.innerHTML = `<div class="empty-state">No batch loaded yet. Build a recipe template first, then load it into Brew Day when you are ready to actually brew.</div>`;
        } else {
          summary.innerHTML = `
            <div>
              <strong style="color:var(--cream);font-size:1.16rem">${escapeHTML(b.name)}</strong><br>
              <span class="small">${escapeHTML(b.type || "Beer")} · ${escapeHTML(b.style || "No style set")}${b.sourceRecipeId ? " · recipe-loaded" : ""}</span>
            </div>
            <div class="batch-summary-grid">
              <div class="summary-pill-card"><div class="stat-label">Target size</div><strong>${b.volume ? escapeHTML(String(b.volume)) + " gal" : "—"}</strong></div>
              <div class="summary-pill-card"><div class="stat-label">OG / FG</div><strong>${b.og || "—"} / ${b.fg || "—"}</strong></div>
              <div class="summary-pill-card"><div class="stat-label">Est. ABV</div><strong>${est ? est.toFixed(2)+"%" : (b.abv ? Number(b.abv).toFixed(2)+"%" : "—")}</strong></div>
              <div class="summary-pill-card"><div class="stat-label">Points to drop</div><strong>${pts ? pts.toFixed(0)+" pts" : "—"}</strong></div>
            </div>
            <div class="notes-box">${escapeHTML(b.ingredients || "No ingredients loaded yet.")}</div>
            <div class="notes-box">${escapeHTML(b.process || "No process notes loaded yet.")}</div>
          `;
        }
      }
      if (biabSnapshot){
        biabSnapshot.innerHTML = renderBiabPlanHtml(b.biab);
      }
      if (quick){
        if (!b.name){
          quick.innerHTML = `
            <button class="btn btn-primary quick-action-btn" data-open-tab="recipes" type="button">Load a saved recipe</button>
            <button class="btn btn-secondary quick-action-btn" data-open-tab="archive" type="button">Browse archive</button>
          `;
        } else {
          quick.innerHTML = `
            <button class="btn btn-primary quick-action-btn" data-open-tab="timers" type="button">${dueNow.length ? `Handle ${dueNow.length} due item${dueNow.length === 1 ? '' : 's'}` : nextUp ? `Next up: ${escapeHTML(nextUp.item).slice(0,28)}` : 'Open timers'}</button>
            <button class="btn btn-secondary quick-action-btn" data-open-tab="packaging" type="button">Packaging ${packagingDone}/${packagingList.length || 0}</button>
            <button class="btn btn-secondary quick-action-btn" id="copyBrewdaySnapshotBtn" type="button">Copy snapshot</button>
            <button class="btn btn-secondary quick-action-btn" id="clearCurrentBatchBtn" type="button">Clear live batch</button>
          `;
          const copyBtn = $("copyBrewdaySnapshotBtn");
          if (copyBtn) copyBtn.onclick = async () => {
            const text = `${b.name || "Untitled batch"}
${b.type || "Beer"} · ${b.style || "—"}
Volume: ${b.volume || "—"} gal
OG/FG: ${b.og || "—"} / ${b.fg || "—"}
ABV: ${computedAbvValue(b.og,b.fg) || b.abv || "—"}%
${b.biab && b.biab.hasPlan ? `Total water: ${b.biab.totalWater.toFixed(2)} gal
Strike temp: ${b.biab.strikeTemp != null ? `${b.biab.strikeTemp.toFixed(1)}°F` : '—'}
Mash/boil: ${b.biab.mashTime != null ? `${b.biab.mashTime.toFixed(0)} min` : '—'} / ${b.biab.boilTime != null ? `${b.biab.boilTime.toFixed(0)} min` : '—'}

` : ''}Next up: ${nextUp ? `${nextUp.item} (${nextUp.detailLabel || ''})` : 'Nothing urgent'}

Notes
${b.notes || "—"}`;
            await navigator.clipboard.writeText(text);
            copyBtn.textContent = "Copied";
            setTimeout(() => copyBtn.textContent = "Copy snapshot", 1200);
          };
          const clearBtn = $("clearCurrentBatchBtn");
          if (clearBtn) clearBtn.onclick = clearCurrentBatch;
        }
      }
    }

    function renderChecklist(){
      const list = data.checklists[data.activeChecklistType] || [];
      $("checklist").innerHTML = list.map((item, index) => `
        <label class="check-item ${item.done ? "done" : ""}">
          <input type="checkbox" data-check-index="${index}" ${item.done ? "checked" : ""} />
          <span class="item-text">${escapeHTML(item.text)}</span>
        </label>
      `).join("");
    }

    function renderGravityInsights(){
      const log = filteredGravityLog();
      const latest = log[0] || null;
      const previous = log[1] || null;
      const actualOg = getActualOg();
      const trendPoints = latest && previous ? (Number(latest.gravity) - Number(previous.gravity)) * 1000 : null;
      const attenuation = latest && actualOg ? calcAttenuation(actualOg, Number(latest.gravity)) : null;
      const abvToDate = latest && actualOg ? calcABV(actualOg, Number(latest.gravity)) : null;

      const items = [
        {
          label: "Actual OG",
          value: actualOg ? Number(actualOg).toFixed(3) : "—",
          sub: actualOg ? "OG reading or target fallback" : "Log an OG or set target OG"
        },
        {
          label: "Latest",
          value: latest ? Number(latest.gravity).toFixed(3) : "—",
          sub: latest ? `${latest.stage} · ${latest.date}` : "No readings yet"
        },
        {
          label: "Trend",
          value: trendPoints == null ? "—" : `${trendPoints > 0 ? "+" : ""}${trendPoints.toFixed(0)} pts`,
          sub: previous ? `vs ${previous.stage} ${Number(previous.gravity).toFixed(3)}` : "Need two readings"
        },
        {
          label: "Atten / ABV",
          value: attenuation == null ? "—" : `${attenuation.toFixed(1)}% · ${abvToDate ? abvToDate.toFixed(2) : "0.00"}%`,
          sub: attenuation == null ? "Needs OG + lower gravity" : "Against actual OG"
        }
      ];

      $("gravityInsights").innerHTML = items.map((item) => `
        <div class="insight-box">
          <div class="helper-label">${escapeHTML(item.label)}</div>
          <div class="insight-value">${escapeHTML(item.value)}</div>
          <div class="small">${escapeHTML(item.sub)}</div>
        </div>
      `).join("");
    }

    function renderGravitySparkline(){
      const svg = $("gravitySparkline");
      const dataPoints = gravityTrendData();
      if (dataPoints.length < 2){
        svg.innerHTML = `<line x1="0" y1="60" x2="300" y2="60" stroke="rgba(255,255,255,.09)" stroke-width="2" stroke-dasharray="4 4"></line>`;
        $("gravityTrendCaption").textContent = dataPoints.length === 1 ? "One reading saved. Add another reading to show the trend." : "Add more than one reading to see a trend line.";
        return;
      }

      const values = dataPoints.map((entry) => Number(entry.gravity));
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = max - min || 0.001;

      const coords = values.map((value, index) => {
        const x = (index / (values.length - 1)) * 300;
        const y = 100 - ((value - min) / range) * 80 + 10;
        return [x, y];
      });

      const line = coords.map(([x,y]) => `${x},${y}`).join(" ");
      const circles = coords.map(([x,y], index) => `<circle cx="${x}" cy="${y}" r="4" fill="${index === coords.length - 1 ? '#ffb266' : '#f5e6c5'}"></circle>`).join("");
      svg.innerHTML = `
        <line x1="0" y1="100" x2="300" y2="100" stroke="rgba(255,255,255,.08)" stroke-width="2"></line>
        <polyline fill="none" stroke="#ffb266" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" points="${line}"></polyline>
        ${circles}
      `;
      $("gravityTrendCaption").textContent = `${dataPoints.length} readings shown from oldest to newest. Latest gravity: ${values[values.length - 1].toFixed(3)}.`;
    }

    function renderGravityLog(){
      $("gravityDate").value = $("gravityDate").value || todayStr();
      document.querySelectorAll("[data-gravity-filter]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.gravityFilter === data.ui.gravityFilter);
      });

      const log = filteredGravityLog();
      $("gravityLog").innerHTML = log.length ? log.map((row) => `
        <div class="log-row">
          <div class="log-head">
            <div>
              <strong style="color:var(--cream)">${Number(row.gravity).toFixed(3)}</strong>
              <span class="pill ${getGravityCategory(row.stage) === "brewday" ? "orange" : "blue"}" style="margin-left:8px">${escapeHTML(row.stage)}</span><br>
              <span class="small">${escapeHTML(row.date)}${row.temp ? ` · ${escapeHTML(row.temp)}°F` : ""}${row.note ? ` · ${escapeHTML(row.note)}` : ""}</span>
            </div>
            <button class="mini-btn" data-delete-gravity="${escapeHTML(row.id)}" type="button">Delete</button>
          </div>
        </div>
      `).join("") : `<div class="empty-state">No gravity readings in this filter yet.</div>`;

      renderGravityInsights();
      renderGravitySparkline();
    }

    function recipeSectionRowTemplate(section, row={}, index=0){
      if (section === "fermentables"){
        return `
          <div class="recipe-row grain" data-section="${section}" data-index="${index}">
            <div class="field"><label>Name</label><input data-key="name" value="${escapeHTML(row.name || "")}" placeholder="${section === "fermentables" ? "Pilsner malt" : "Crystal 60"}" /></div>
            <div class="field"><label>Amount</label><input data-key="amount" type="text" inputmode="decimal" value="${escapeHTML(row.amount || "")}" placeholder="${section === "fermentables" ? "8" : "12"}" /></div>
            <div class="field"><label>Unit</label><select data-key="unit"><option ${row.unit==="lb"?"selected":""}>lb</option><option ${row.unit==="oz"?"selected":""}>oz</option><option ${row.unit==="kg"?"selected":""}>kg</option><option ${row.unit==="g"?"selected":""}>g</option></select></div>
            <div class="field"><label>°L</label><input data-key="lovibond" type="text" inputmode="decimal" value="${escapeHTML(row.lovibond || "")}" placeholder="2" /></div>
            <div class="field"><label>% grain bill</label><div class="grain-percent">${row.percent ? escapeHTML(String(row.percent)) + "%" : "—"}</div></div>
            <button class="mini-btn" type="button" data-remove-recipe-row="${section}" data-index="${index}">Remove</button>
          </div>
        `;
      }
      if (section === "hops"){
        return `
          <div class="recipe-row hops" data-section="${section}" data-index="${index}">
            <div class="field"><label>Hop</label><input data-key="name" value="${escapeHTML(row.name || "")}" placeholder="Citra" /></div>
            <div class="field"><label>Amt</label><input data-key="amount" type="text" inputmode="decimal" value="${escapeHTML(row.amount || "")}" placeholder="1" /></div>
            <div class="field"><label>Unit</label><select data-key="unit"><option ${row.unit==="oz"?"selected":""}>oz</option><option ${row.unit==="g"?"selected":""}>g</option></select></div>
            <div class="field"><label>AA%</label><input data-key="aa" type="text" inputmode="decimal" value="${escapeHTML(row.aa || "")}" placeholder="12" /></div>
            <div class="field"><label>Time</label><input data-key="time" type="text" value="${escapeHTML(row.time || "")}" placeholder="15" /></div>
            <div class="field"><label>Stage</label><select data-key="use"><option ${row.use==="Boil"?"selected":""}>Boil</option><option ${row.use==="Whirlpool"?"selected":""}>Whirlpool</option><option ${row.use==="Dry hop"?"selected":""}>Dry hop</option><option ${row.use==="First wort"?"selected":""}>First wort</option></select></div>
            <button class="mini-btn" type="button" data-remove-recipe-row="${section}" data-index="${index}">Remove</button>
          </div>
        `;
      }
      if (section === "yeast"){
        return `
          <div class="recipe-row compact" data-section="${section}" data-index="${index}">
            <div class="field"><label>Yeast</label><input data-key="name" value="${escapeHTML(row.name || "")}" placeholder="US-05" /></div>
            <div class="field"><label>Amount</label><input data-key="amount" type="text" inputmode="decimal" value="${escapeHTML(row.amount || "")}" placeholder="1" /></div>
            <div class="field"><label>Unit</label><select data-key="unit"><option ${row.unit==="packet"?"selected":""}>packet</option><option ${row.unit==="starter"?"selected":""}>starter</option><option ${row.unit==="g"?"selected":""}>g</option><option ${row.unit==="ml slurry"?"selected":""}>ml slurry</option></select></div>
            <div class="field"><label>Pitch note</label><input data-key="timing" value="${escapeHTML(row.timing || "")}" placeholder="Primary / starter built day before" /></div>
            <button class="mini-btn" type="button" data-remove-recipe-row="${section}" data-index="${index}">Remove</button>
          </div>
        `;
      }
      return `
        <div class="recipe-row compact" data-section="${section}" data-index="${index}">
          <div class="field"><label>Ingredient</label><input data-key="name" value="${escapeHTML(row.name || "")}" placeholder="Lactose / orange zest / cacao nibs" /></div>
          <div class="field"><label>Amount</label><input data-key="amount" type="text" inputmode="decimal" value="${escapeHTML(row.amount || "")}" placeholder="8" /></div>
          <div class="field"><label>Unit</label><input data-key="unit" value="${escapeHTML(row.unit || "")}" placeholder="oz / g / tsp" /></div>
          <div class="field"><label>Timing</label><input data-key="timing" value="${escapeHTML(row.timing || "")}" placeholder="10 min / secondary / packaging" /></div>
          <button class="mini-btn" type="button" data-remove-recipe-row="${section}" data-index="${index}">Remove</button>
        </div>
      `;
    }

    function normalizeRecipeSectionRowsFromDom(section){
      const map = {
        fermentables:"fermentablesRows",
        hops:"hopsRows",
        yeast:"yeastRows",
        otherIngredients:"otherIngredientRows"
      };
      const container = $(map[section]);
      if (!container) return clone(defaultRecipeSections()[section] || []);
      const rows = [...container.querySelectorAll(".recipe-row")].map((row) => {
        const payload = {};
        row.querySelectorAll("[data-key]").forEach((field) => payload[field.dataset.key] = field.value.trim());
        return payload;
      }).filter((row) => Object.values(row).some(Boolean));
      return rows.length ? rows : clone(defaultRecipeSections()[section] || []);
    }

    function getRecipeEditorSections(){
      return {
        fermentables: normalizeRecipeSectionRowsFromDom("fermentables"),
        hops: normalizeRecipeSectionRowsFromDom("hops"),
        yeast: normalizeRecipeSectionRowsFromDom("yeast"),
        otherIngredients: normalizeRecipeSectionRowsFromDom("otherIngredients"),
        mashGuidelines: {
          temp: $("templateMashTemp")?.value || "",
          time: $("templateMashTime")?.value || "",
          boilTime: $("templateBiabBoilTime")?.value || "",
          boilOff: $("templateBiabBoilOff")?.value || "",
          trub: $("templateBiabTrub")?.value || "",
          absorption: $("templateBiabAbsorption")?.value || "",
          grainTemp: $("templateBiabGrainTemp")?.value || "",
          notes: $("templateMashNotes")?.value.trim() || ""
        }
      };
    }

    function setRecipeEditorSections(sections){
      const normalized = normalizeRecipeSections(sections);
      const map = {
        fermentables:"fermentablesRows",
        hops:"hopsRows",
        yeast:"yeastRows",
        otherIngredients:"otherIngredientRows"
      };
      Object.entries(map).forEach(([section, id]) => {
        const container = $(id);
        if (!container) return;
        container.innerHTML = (normalized[section] || []).map((row, index) => recipeSectionRowTemplate(section, row, index)).join("");
      });
      $("templateMashTemp").value = normalized.mashGuidelines.temp || "";
      $("templateMashTime").value = normalized.mashGuidelines.time || "";
      $("templateBiabBoilTime").value = normalized.mashGuidelines.boilTime || "";
      $("templateBiabBoilOff").value = normalized.mashGuidelines.boilOff || "";
      $("templateBiabTrub").value = normalized.mashGuidelines.trub || "";
      $("templateBiabAbsorption").value = normalized.mashGuidelines.absorption || "";
      $("templateBiabGrainTemp").value = normalized.mashGuidelines.grainTemp || "";
      $("templateMashNotes").value = normalized.mashGuidelines.notes || "";
      updateGrainBillDisplay();
    }

    function addRecipeSectionRow(section){
      const sections = getRecipeEditorSections();
      sections[section] = [...(sections[section] || []), clone(defaultRecipeSections()[section][0])];
      setRecipeEditorSections(sections);
    }

    function updateGrainBillDisplay(){
      const combined = [
        ...normalizeRecipeSectionRowsFromDom("fermentables")
      ];
      const totalLb = combined.reduce((sum, row) => sum + convertToPounds(row.amount, row.unit), 0);
      if ($("grainBillTotalDisplay")) $("grainBillTotalDisplay").textContent = formatWeightLb(totalLb);
      ["fermentablesRows"].forEach((containerId) => {
        const container = $(containerId);
        if (!container) return;
        [...container.querySelectorAll(".recipe-row")].forEach((row) => {
          const amount = row.querySelector('[data-key="amount"]')?.value || "";
          const unit = row.querySelector('[data-key="unit"]')?.value || "";
          const lb = convertToPounds(amount, unit);
          const pct = totalLb > 0 && lb > 0 ? (lb / totalLb) * 100 : 0;
          const cell = row.querySelector(".grain-percent");
          if (cell) cell.textContent = pct > 0 ? `${pct.toFixed(1)}%` : "—";
        });
      });
      updateRecipeEstimates();
      renderRecipeBiabPlanner();
    }


    function updateRecipeEstimates(){
      const og = $("templateOG")?.value;
      const vol = $("templateVolume")?.value;
      const hopsRows = normalizeRecipeSectionRowsFromDom("hops");
      const fermentableRows = normalizeRecipeSectionRowsFromDom("fermentables");
      const ibu = estimateTinsethIBU(og, vol, hopsRows);
      const srm = estimateMoreySRM(vol, fermentableRows);
      const el = $("recipeEstimatesDisplay");
      if (!el) return;
      const parts = [];
      if (ibu != null) parts.push(`Est. IBU: <strong style="color:var(--cream)">${ibu.toFixed(0)}</strong> <span class="small">(Tinseth${hopsRows.some(r => r.aa) ? "" : ", assumes ~10% AA"})</span>`);
      if (srm != null) parts.push(`Est. SRM: <strong style="color:var(--cream)">${srm.toFixed(1)}</strong> <span style="display:inline-block;width:14px;height:14px;border-radius:50%;vertical-align:middle;margin-left:4px;border:1px solid rgba(255,255,255,.15);background:${srmToColor(srm)}"></span>`);
      el.innerHTML = parts.length ? parts.join(" &nbsp;·&nbsp; ") : "Add OG, volume, hops with times, and fermentables with °L to see IBU and SRM estimates.";
    }

    function buildRecipeDetailSection(title, items){
      const filled = items.filter(Boolean);
      return `
        <div class="recipe-detail-section">
          <strong style="color:var(--cream)">${escapeHTML(title)}</strong>
          ${filled.length ? `<ul class="recipe-detail-list">${filled.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>` : `<div class="recipe-empty">Nothing saved yet.</div>`}
        </div>
      `;
    }

    function renderRecipeSectionsDetail(recipe){
      const sections = normalizeRecipeSections(recipe.sections);
      const mash = sections.mashGuidelines || {};
      return [
        buildRecipeDetailSection("Fermentables", sections.fermentables.filter((row) => row.name).map((row) => `${row.name} — ${row.amount || "—"} ${row.unit || ""}${row.lovibond ? ` · ${row.lovibond}°L` : ""}${row.percent ? ` · ${row.percent}%` : ""}`)),
        buildRecipeDetailSection("Hops", sections.hops.filter((row) => row.name).map((row) => `${row.name}${row.aa ? ` (${row.aa}% AA)` : ""} — ${row.amount || "—"} ${row.unit || ""}${row.time ? ` · ${row.time}` : ""}${row.use ? ` · ${row.use}` : ""}`)),
        buildRecipeDetailSection("Yeast", sections.yeast.filter((row) => row.name).map((row) => `${row.name} — ${row.amount || "—"} ${row.unit || ""}${row.timing ? ` · ${row.timing}` : ""}`)),
        buildRecipeDetailSection("Other ingredients", sections.otherIngredients.filter((row) => row.name).map((row) => `${row.name} — ${row.amount || "—"} ${row.unit || ""}${row.timing ? ` · ${row.timing}` : ""}`)),
        buildRecipeDetailSection("BIAB brew plan", [
          mash.temp ? `Mash temp: ${mash.temp}°F` : "",
          mash.time ? `Mash time: ${mash.time} min` : "",
          mash.boilTime ? `Boil time: ${mash.boilTime} min` : "",
          mash.boilOff ? `Boiloff: ${mash.boilOff} gal/hr` : "",
          mash.trub ? `Trub loss: ${mash.trub} gal` : "",
          mash.absorption ? `Grain absorption: ${mash.absorption} gal/lb` : "",
          mash.grainTemp ? `Grain temp: ${mash.grainTemp}°F` : "",
          mash.ratio ? `Legacy water ratio: ${mash.ratio} qt/lb` : "",
          mash.spargeTemp ? `Legacy sparge temp: ${mash.spargeTemp}°F` : "",
          mash.notes ? `Notes: ${mash.notes}` : ""
        ])
      ].join("");
    }

    function currentRecipeDefaults(){
      return {
        schedule: clone(data.schedule || []),
        timers: Object.fromEntries(TIMER_KEYS.map((key) => [key, { initial: data.timers[key].initial }])),
        packaging: {
          type: data.packaging.type || "bottling",
          tags: data.packaging.tags || "",
          primingTargetVols: data.packaging.primingTargetVols || "",
          kegTargetVols: data.packaging.kegTargetVols || "",
          kegPsi: data.packaging.kegPsi || ""
        }
      };
    }

    function updateRecipeDefaultsUi(defaults){
      const d = { ...defaultRecipeSections().defaults, ...(defaults || {}) };
      if ($("recipeDefaultsScheduleCount")) $("recipeDefaultsScheduleCount").textContent = `${(d.schedule || []).length} item${(d.schedule || []).length===1?"":"s"} saved`;
      const timerCount = Object.keys(d.timers || {}).filter((k) => d.timers[k] && d.timers[k].initial).length;
      if ($("recipeDefaultsTimerCount")) $("recipeDefaultsTimerCount").textContent = `${timerCount} preset${timerCount===1?"":"s"} saved`;
      const hasPack = d.packaging && Object.values(d.packaging).some(Boolean);
      if ($("recipeDefaultsPackagingCount")) $("recipeDefaultsPackagingCount").textContent = hasPack ? `${d.packaging.type || "packaging"} defaults saved` : "No packaging defaults yet";
      if ($("recipeDefaultsSummary")) $("recipeDefaultsSummary").textContent = `Schedule: ${(d.schedule || []).length} saved · Timers: ${timerCount} preset${timerCount===1?"":"s"} · Packaging: ${hasPack ? (d.packaging.type || "saved") : "none"}`;
    }

    function clearRecipeEditor(){
      ["templateName","templateStyle","templateVolume","templateOG","templateFG","templateABV","templateProcess","templateTags","templateMashTemp","templateMashTime","templateBiabBoilTime","templateBiabBoilOff","templateBiabTrub","templateBiabAbsorption","templateBiabGrainTemp","templateMashNotes"].forEach((id) => { if ($(id)) $(id).value = ""; });
      $("templateType").value = "Beer";
      setRecipeEditorSections(defaultRecipeSections());
      window.recipeDraftDefaults = clone(defaultRecipeSections().defaults);
      updateRecipeDefaultsUi(window.recipeDraftDefaults);
      data.ui.editingRecipeId = null;
      if ($("saveTemplateBtn")) $("saveTemplateBtn").textContent = "Save recipe";
      if ($("recipeEditorTitle")) $("recipeEditorTitle").textContent = "Build a recipe";
      if ($("cancelRecipeEditBtn")) $("cancelRecipeEditBtn").hidden = true;
      renderRecipeBiabPlanner();
    }

    function populateRecipeEditor(recipe){
      $("templateName").value = recipe.name || "";
      $("templateStyle").value = recipe.style || "";
      $("templateType").value = recipe.type || "Beer";
      $("templateVolume").value = recipe.volume || "";
      $("templateOG").value = recipe.og || "";
      $("templateFG").value = recipe.fg || "";
      $("templateProcess").value = recipe.process || recipe.notes || "";
      $("templateTags").value = Array.isArray(recipe.tags) ? recipe.tags.join(", ") : "";
      setRecipeEditorSections(recipe.sections || defaultRecipeSections());
      window.recipeDraftDefaults = clone((recipe.sections || {}).defaults || defaultRecipeSections().defaults);
      updateRecipeDefaultsUi(window.recipeDraftDefaults);
      data.ui.editingRecipeId = recipe.id;
      syncRecipeAbvField();
      if ($("saveTemplateBtn")) $("saveTemplateBtn").textContent = "Update recipe";
      if ($("recipeEditorTitle")) $("recipeEditorTitle").textContent = "Edit recipe";
      if ($("cancelRecipeEditBtn")) $("cancelRecipeEditBtn").hidden = false;
      renderRecipeBiabPlanner();
    }

    function renderRecipes(){
      if (!$("recipeList")) return;
      const query = (data.ui.recipeQuery || "").trim().toLowerCase();
      const typeFilter = data.ui.recipeTypeFilter || "all";
      const sortMode = data.ui.recipeSort || "recent";
      let recipes = [...data.recipes];

      if (query){
        recipes = recipes.filter((recipe) => {
          const haystack = [recipe.name, recipe.style, recipe.type, recipe.ingredients, recipe.process, recipe.notes, recipe.quick, buildIngredientsTextFromSections(recipe.sections), ...(recipe.tags || [])]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return haystack.includes(query);
        });
      }
      if (typeFilter !== "all") recipes = recipes.filter((recipe) => (recipe.type || "Beer") === typeFilter);

      recipes.sort((a,b) => {
        if (sortMode === "name") return String(a.name || "").localeCompare(String(b.name || ""));
        if (sortMode === "style") return String(a.style || "").localeCompare(String(b.style || ""));
        if (sortMode === "abv") return (parseFloat(b.abv || 0) || 0) - (parseFloat(a.abv || 0) || 0);
        return String(b.id || "").localeCompare(String(a.id || ""));
      });

      if ($("recipeCountStat")) $("recipeCountStat").textContent = String(data.recipes.length);
      const selected = data.recipes.find((recipe) => recipe.id === data.selectedRecipeId) || recipes[0] || data.recipes[0];
      if (selected) data.selectedRecipeId = selected.id;
      if ($("recipeSelectedName")) $("recipeSelectedName").textContent = selected ? String(selected.name || "Untitled") : "—";
      if ($("recipeSelectedMeta")) $("recipeSelectedMeta").textContent = selected ? `${selected.type || "Beer"} · ${selected.style || "No style"}${selected.abv ? ` · ${selected.abv}%` : ""}` : "Pick one to inspect or brew from";

      $("recipeList").innerHTML = recipes.length ? recipes.map((recipe) => `
        <div class="recipe-item ${recipe.id === data.selectedRecipeId ? "active" : ""}" data-recipe-id="${escapeHTML(String(recipe.id))}">
          <div class="recipe-item-title">
            <h4>${escapeHTML(recipe.name || "Untitled recipe")}</h4>
            <span class="pill berry">${escapeHTML(recipe.type || "Beer")}</span>
          </div>
          <p class="recipe-item-meta">${escapeHTML(recipe.style || "No style")} ${recipe.volume ? `· ${escapeHTML(String(recipe.volume))} gal` : ""} ${recipe.abv ? `· ${escapeHTML(String(recipe.abv))}%` : ""}</p>
          <p class="recipe-item-copy">${escapeHTML(recipe.process || recipe.notes || buildIngredientsTextFromSections(recipe.sections) || recipe.ingredients || "No recipe details yet.")}</p>
          <div class="chips">${(recipe.tags || []).map((tag) => `<span class="chip">${escapeHTML(tag)}</span>`).join("")}</div>
        </div>
      `).join("") : `<div class="empty-state">${data.recipes.length ? "No recipes match this filter yet." : "No saved recipes yet. Build one in Recipe Builder and it will show up here."}</div>`;

      if (!selected){
        $("recipeDetail").innerHTML = "No recipe selected yet.";
      } else {
        const processPreview = selected.process || selected.notes || selected.quick || "No process notes yet.";
        const sectionCounts = recipeSectionsSummary(selected.sections);
        if ($("recipeUtilityNote")) $("recipeUtilityNote").textContent = `Selected: ${selected.name || "Untitled"}. Load it into the current batch, duplicate it into a new variant, or edit it below.`;
        $("recipeDetail").innerHTML = `
          <div class="recipe-detail-top">
            <div class="recipe-highlight">
              <strong style="color:var(--cream);font-size:1.08rem">${escapeHTML(selected.name)}</strong><br>
              <span class="small">${escapeHTML(selected.type || "Beer")} · ${escapeHTML(selected.style || "—")} ${selected.volume ? `· ${escapeHTML(String(selected.volume))} gal` : ""}${selected.abv ? ` · ${escapeHTML(String(selected.abv))}% ABV` : ""}</span>
            </div>
            ${(selected.tags || []).length ? `<div class="chips">${selected.tags.map((tag) => `<span class="chip">${escapeHTML(tag)}</span>`).join("")}</div>` : ""}
            <div class="recipe-detail-actions">
              <button class="btn btn-primary" type="button" id="loadRecipeToBatch">Load into current batch</button>
              <button class="mini-btn" type="button" id="editRecipeBtn">Edit recipe</button>
              <button class="mini-btn" type="button" id="duplicateRecipeBtnInline">Duplicate recipe</button>
              <button class="mini-btn" type="button" id="deleteTemplateBtn">Delete recipe</button>
            </div>
          </div>
          <div class="recipe-highlight">
            <strong style="color:var(--cream)">Recipe structure</strong>
            <div class="chips">
              <span class="chip">${sectionCounts.fermentables} fermentables</span>
                            <span class="chip">${sectionCounts.hops} hop additions</span>
              <span class="chip">${sectionCounts.yeast} yeast entries</span>
              <span class="chip">${sectionCounts.other} other additions</span>
            </div>
          </div>
          ${renderRecipeSectionsDetail(selected)}
          <div class="recipe-highlight"><strong style="color:var(--cream)">Process</strong><div class="detail-copy">${escapeHTML(processPreview)}</div></div>
        `;

        const loadSelectedRecipe = () => {
          const normalizedSections = normalizeRecipeSections(selected.sections);
          const biabPlan = buildBiabPlan(normalizedSections, selected.volume || "");
          const defaults = normalizedSections.defaults || {};

          data.currentBatch = buildCurrentBatchFromRecipe(selected, normalizedSections, biabPlan);
          if ((defaults.schedule || []).length) data.schedule = clone(defaults.schedule);
          applyTimerDefaultsFromMap(defaults.timers || {});
          applyBiabTimerFallbacks(biabPlan, defaults.timers || {});
          if (defaults.packaging){
            data.packaging = { ...data.packaging, ...defaults.packaging };
          }
          renderBatchInputs();
          renderSummary();
          renderMiniBatchSummary();
          persistData();
          setActiveTab("brewday");
        };

        const duplicateSelectedRecipe = () => {
          const cloneRecipe = { ...selected, id: makeId("recipe"), name: `${selected.name || "Recipe"} copy` };
          data.recipes.unshift(cloneRecipe);
          data.selectedRecipeId = cloneRecipe.id;
          persistData();
          renderRecipes();
          populateRecipeEditor(cloneRecipe);
          setActiveTab("recipes");
          window.scrollTo({ top: 0, behavior: "smooth" });
        };

        $("loadRecipeToBatch").onclick = loadSelectedRecipe;
        $("editRecipeBtn").onclick = () => {
          populateRecipeEditor(selected);
          persistData();
          setActiveTab("recipes");
          window.scrollTo({ top: 0, behavior: "smooth" });
        };
        $("duplicateRecipeBtnInline").onclick = duplicateSelectedRecipe;
        $("deleteTemplateBtn").onclick = () => {
          if (!confirm("Delete this recipe?")) return;
          data.recipes = data.recipes.filter((recipe) => recipe.id !== selected.id);
          data.selectedRecipeId = data.recipes[0] ? data.recipes[0].id : null;
          persistData();
          renderRecipes();
        };
      }

      const aiText = generateAiPrompt();
      if ($("libraryAiBox")) $("libraryAiBox").textContent = aiText;
      if ($("dashboardAiSummary")) $("dashboardAiSummary").textContent = aiText;
    }

    function renderPackagingHelpers(){
      const gallons = Number($("bottleBatchGallons")?.value || data.currentBatch.volume || 0);
      const bottleOz = Number($("bottleSizeOz")?.value || 12);
      const lossPct = Number($("bottleLossPct")?.value || 5);
      const bottlePlan = calculateBottleCount({ gallons, bottleOz, lossPct });
      if (bottlePlan){
        $("bottleCountResult").innerHTML = `<strong style="color:var(--cream)">${bottlePlan.fullBottles}</strong> full bottles with about <strong style="color:var(--cream)">${bottlePlan.leftoverOz.toFixed(0)} oz</strong> left after a ${bottlePlan.lossPct.toFixed(0)}% loss allowance.`;
      } else {
        $("bottleCountResult").textContent = "Enter packaged volume and bottle size.";
      }

      const temp = Number($("kegTemp")?.value || 0);
      const vols = Number($("kegVolumes")?.value || 0);
      const kegSize = Number($("kegSizeGallons")?.value || data.currentBatch.volume || 5);
      const kegPlan = calculateKegPressure({ tempF: temp, targetVolumesCo2: vols });
      if (kegPlan){
        $("kegPressureResult").innerHTML = `Set the keg around <strong style="color:var(--cream)">${kegPlan.psi.toFixed(1)} PSI</strong> at ${temp.toFixed(0)}°F for about ${vols.toFixed(1)} volumes CO₂. ${kegSize ? `Works well as a starting point for a ${kegSize.toFixed(1)} gal keg.` : ""}`;
      } else {
        $("kegPressureResult").textContent = "Enter temp and target carbonation.";
      }
    }

    function renderPackagingChecklist(){
      const type = data.packaging.type;
      $("packagingNotes").value = data.packaging.notes || "";
      $("tastingNotes").value = data.packaging.tastingNotes || "";
      $("batchRating").value = data.packaging.rating || "";
      $("batchTags").value = data.packaging.tags || "";
      $("wouldBrewAgain").checked = Boolean(data.packaging.wouldBrewAgain);
      $("packagingChecklist").innerHTML = data.packaging.checklists[type].map((item, index) => `
        <label class="check-item ${item.done ? "done" : ""}">
          <input type="checkbox" data-pack-index="${index}" ${item.done ? "checked" : ""} />
          <span class="item-text">${escapeHTML(item.text)}</span>
        </label>
      `).join("");
      const summaryBits = [data.packaging.type === "kegging" ? "Kegging path" : "Bottling path", data.packaging.rating ? `Rating ${data.packaging.rating}/5` : "Not rated yet", data.packaging.wouldBrewAgain ? "Would brew again" : "Would-brew-again not set", data.packaging.tags ? `Tags: ${data.packaging.tags}` : "No archive tags yet"];
      $("archivePrepSummary").textContent = summaryBits.join(" · ");
      const ready = getPackagingReadiness();
      $("packagingReadinessBox").innerHTML = `<div class="helper-label">Archive readiness</div><div style="margin-top:6px"><strong style="color:var(--cream)">${ready.score}/${ready.max}</strong> archive checks lined up</div><div class="small" style="margin-top:6px">Checklist ${ready.done}/${ready.total || 0} · FG ${(data.currentBatch.fg || sortedGravityLog().some((entry) => entry.stage === 'FG')) ? 'logged' : 'not logged'} · Packaging notes ${data.packaging.notes ? 'saved' : 'missing'} · Tasting context ${(data.packaging.tastingNotes || data.packaging.rating) ? 'saved' : 'missing'}</div>`;
      renderPackagingHelpers();
    }

    function renderSchedule(){
      if (!$("scheduleSyncToggle") || !$("scheduleRibbon") || !$("scheduleList")) return;
      $("scheduleSyncToggle").checked = Boolean(data.ui.scheduleSync);
      const decorated = getScheduleDecorated();
      const dueNow = decorated.filter((row) => row.statusLabel === "Due now");
      const soon = decorated.filter((row) => row.statusLabel === "Soon").length;
      const nextUp = decorated.find((row) => row.statusLabel === "Next up") || decorated.find((row) => row.statusLabel === "Soon");
      const overdue = decorated.filter((row) => row.statusLabel === "Overdue");
      $("scheduleRibbon").innerHTML = decorated.length ? `<div class="ribbon-card"><div class="helper-label">Due now</div><strong>${dueNow.length}</strong><div class="small">${dueNow.length ? "Handle these before you get distracted." : "Nothing screaming for attention."}</div></div><div class="ribbon-card"><div class="helper-label">Coming soon</div><strong>${soon}</strong><div class="small">${soon ? "Items landing inside the next 5 min." : "No near-term additions."}</div></div><div class="ribbon-card"><div class="helper-label">Next call</div><strong>${escapeHTML(nextUp ? nextUp.item : "—")}</strong><div class="small">${escapeHTML(nextUp ? nextUp.detailLabel : "Additions will show here once synced.")}</div></div>` : "";
      if ($("scheduleQueueSummary")) {
        $("scheduleQueueSummary").innerHTML = decorated.length ? `<strong style="color:var(--cream)">${overdue.length ? `${overdue.length} overdue` : dueNow.length ? `${dueNow.length} due now` : nextUp ? `Next: ${escapeHTML(nextUp.item)}` : 'Schedule loaded'}</strong><div style="height:6px"></div><div class="small">Tap <strong>Done</strong> to remove an addition once you have actually made it. Use <strong>+5</strong> when the boil or your pace drifts.</div>` : `No boil schedule items yet.`;
      }
      $("scheduleList").innerHTML = decorated.length ? decorated.map((row) => {
        const fillWidth = row.statusLabel === "Due now" ? 100 : row.statusLabel === "Soon" ? Math.max(25, 100 - ((row.untilDue - 2) * 18)) : row.statusLabel === "Next up" ? 38 : row.statusLabel === "Overdue" ? 100 : 14;
        return `<div class="schedule-row ${row.rowClass || ""}"><div class="schedule-head"><div><strong style="color:var(--cream)">${escapeHTML(String(row.minutesLeft))} min left</strong> · ${escapeHTML(row.item)}<br><span class="small">${row.note ? escapeHTML(row.note) + " · " : ""}${escapeHTML(row.detailLabel || `${row.minutesLeft} min left`)}</span><div class="due-bar"><div class="due-fill" style="width:${Math.max(0, Math.min(100, fillWidth))}%"></div></div></div><div class="tag-row"><span class="pill ${row.statusLabel === "Due now" ? "red" : row.statusLabel === "Soon" ? "orange" : row.statusLabel === "Next up" ? "blue" : row.statusLabel === "Overdue" ? "berry" : ""}">${escapeHTML(row.statusLabel)}</span><button class="mini-btn" data-bump-schedule="${escapeHTML(row.id)}" data-minutes="5" type="button">+5</button><button class="mini-btn" data-complete-schedule="${escapeHTML(row.id)}" type="button">Done</button><button class="mini-btn" data-delete-schedule="${escapeHTML(row.id)}" type="button">Delete</button></div></div></div>`;
      }).join("") : `<div class="empty-state">No boil schedule items yet.</div>`;
    }

    function renderArchive(){
      $("archiveSearch").value = data.ui.archiveQuery || "";
      document.querySelectorAll("[data-archive-filter]").forEach((btn) => btn.classList.toggle("active", btn.dataset.archiveFilter === (data.ui.archiveFilter || 'all')));
      const query = (data.ui.archiveQuery || "").trim().toLowerCase();
      const mode = data.ui.archiveFilter || 'all';
      const filtered = data.archive.filter((item) => {
        if (mode === 'brew-again' && !item.wouldBrewAgain) return false;
        if (!query) return true;
        const haystack = [item.name,item.style,item.type,item.notes,item.ingredients,item.process,item.packagingNotes,item.tastingNotes,item.tags].join(" ").toLowerCase();
        return haystack.includes(query);
      });
      $("archiveGrid").innerHTML = filtered.length ? filtered.map((item) => `<div class="archive-card"><div class="archive-head"><div><h4>${escapeHTML(item.name)}</h4><p>${escapeHTML(item.style)} · ${escapeHTML(item.type)}</p></div><span class="pill blue">${escapeHTML(item.date)}</span></div><div style="height:10px"></div><div class="chips"><span class="chip">${item.volume ? `${escapeHTML(String(item.volume))} gal` : "—"}</span><span class="chip">OG ${item.og ? escapeHTML(Number(item.og).toFixed(3)) : "—"}</span><span class="chip">FG ${item.fg ? escapeHTML(Number(item.fg).toFixed(3)) : "—"}</span><span class="chip">${item.abv ? `${escapeHTML(Number(item.abv).toFixed(2))}%` : "—"}</span>${item.rating ? `<span class="chip">${escapeHTML(String(item.rating))}/5</span>` : ""}${item.wouldBrewAgain ? `<span class="chip">Brew again</span>` : ""}</div>${item.tags ? `<div style="height:10px"></div><div class="small">Tags · ${escapeHTML(item.tags)}</div>` : ""}${item.notes ? `<div style="height:10px"></div><p>${escapeHTML(item.notes)}</p>` : ""}${item.ingredients ? `<div style="height:8px"></div><p><strong style="color:var(--cream)">Ingredients</strong> · ${escapeHTML(item.ingredients)}</p>` : ""}${item.tastingNotes ? `<div style="height:8px"></div><p>${escapeHTML(item.tastingNotes)}</p>` : ""}<div class="archive-inline-actions"><button class="mini-btn" data-load-archive="${escapeHTML(item.id)}" type="button">Reload to Brew Day</button><button class="mini-btn" data-rebrew-archive="${escapeHTML(item.id)}" type="button">Rebrew as recipe</button><button class="mini-btn" data-delete-archive="${escapeHTML(item.id)}" type="button">Delete</button></div></div>`).join("") : `<div class="empty-state">${query || mode !== 'all' ? "No archive matches that filter." : "No archived batches yet."}</div>`;
      renderCompareSelects();
    }

    /* =========================================================
   Render pipeline: live batch, dashboard, timers, archive, recipes
   ========================================================= */

function renderSummary(){
      const b = data.currentBatch;
      const list = data.checklists[data.activeChecklistType] || [];
      const done = list.filter((item) => item.done).length;
      const total = list.length;
      const est = calcABV(b.og, b.fg);
      const biabLine = b.biab && b.biab.hasPlan
        ? `Total water <strong style="color:var(--cream)">${b.biab.totalWater.toFixed(2)} gal</strong> · Strike <strong style="color:var(--cream)">${b.biab.strikeTemp != null ? `${b.biab.strikeTemp.toFixed(1)}°F` : "—"}</strong> · Mash/boil <strong style="color:var(--cream)">${b.biab.mashTime != null ? `${b.biab.mashTime.toFixed(0)}m` : "—"} / ${b.biab.boilTime != null ? `${b.biab.boilTime.toFixed(0)}m` : "—"}</strong>`
        : "";

      $("summaryBox").innerHTML = `
        <strong style="color:var(--cream)">${escapeHTML(b.name || "Unnamed batch")}</strong><br>
        <span class="small">${escapeHTML(b.type || "—")} · ${escapeHTML(b.style || "—")} · ${b.volume ? `${escapeHTML(String(b.volume))} gal` : "—"}</span>
        <div style="height:10px"></div>
        <div>OG: <strong style="color:var(--cream)">${b.og ? escapeHTML(Number(b.og).toFixed(3)) : "—"}</strong> · FG: <strong style="color:var(--cream)">${b.fg ? escapeHTML(Number(b.fg).toFixed(3)) : "—"}</strong> · Est ABV: <strong style="color:var(--cream)">${est ? escapeHTML(est.toFixed(2) + "%") : (b.abv ? escapeHTML(Number(b.abv).toFixed(2) + "%") : "—")}</strong></div>
        <div style="height:10px"></div>
        <div>Checklist progress: <strong style="color:var(--cream)">${done}/${total}</strong></div>
        <div style="height:10px"></div>
        <div>${escapeHTML(b.notes || "No running notes yet.").replace(/\n/g, "<br>")}</div>
      `;
    }

    function renderMiniBatchSummary(){
      const b = data.currentBatch;
      const actualOg = getActualOg();
      const latestGravity = sortedGravityLog()[0];
      $("miniBatchSummary").innerHTML = `
        <strong style="color:var(--cream)">${escapeHTML(b.name || "Unnamed batch")}</strong><br>
        <span class="small">${escapeHTML(b.style || "—")} · ${escapeHTML(b.type || "—")} · ${b.volume ? `${escapeHTML(String(b.volume))} gal` : "—"}</span>
        <div style="height:10px"></div>
        <div>Target OG ${b.og ? escapeHTML(Number(b.og).toFixed(3)) : "—"} · Actual OG ${actualOg ? escapeHTML(Number(actualOg).toFixed(3)) : "—"} · Latest ${latestGravity ? escapeHTML(Number(latestGravity.gravity).toFixed(3)) : "—"}</div>
      `;
    }

    function renderBoilSnapshot(){
      const schedule = getScheduleDecorated();
      const boilRemaining = getTimerRemaining(data.timers.boil);

      if (!schedule.length){
        $("boilSnapshot").innerHTML = "Add schedule items to see a live boil snapshot here.";
        return;
      }

      const dueNow = schedule.filter((item) => item.statusLabel === "Due now");
      const nextUp = schedule.find((item) => item.statusLabel === "Next up");
      const soon = schedule.filter((item) => item.statusLabel === "Soon").slice(0, 3);

      $("boilSnapshot").innerHTML = `
        <strong style="color:var(--cream)">Boil time left:</strong> ${formatSeconds(boilRemaining)}
        <div style="height:10px"></div>
        <div><span class="pill ${data.ui.scheduleSync ? "green" : ""}">${data.ui.scheduleSync ? "Synced to boil timer" : "Manual schedule mode"}</span></div>
        <div style="height:12px"></div>
        ${dueNow.length ? dueNow.map((item) => `<div><span class="pill red">Due now</span> ${escapeHTML(item.item)} <span class="small">${item.note ? escapeHTML(item.note) : ""}</span></div>`).join("<div style='height:8px'></div>") : "<div>No additions due right now.</div>"}
        ${nextUp ? `<div style="height:12px"></div><div><span class="pill blue">Next up</span> ${escapeHTML(nextUp.item)} <span class="small">${escapeHTML(nextUp.detailLabel)}</span></div>` : ""}
        ${soon.length ? `<div style="height:12px"></div><div class="small">Coming up soon: ${soon.map((item) => `${item.item} (${item.detailLabel})`).map(escapeHTML).join(" · ")}</div>` : ""}
      `;
    }

    function getActiveTimerEntries(){
      return TIMER_KEYS.map((key) => {
        const timer = data.timers[key];
        const remaining = getTimerRemaining(timer);
        const activeish = timer.running || remaining !== timer.initial || remaining === 0;
        return { key, timer, remaining, activeish };
      }).filter((entry) => entry.activeish);
    }

    function renderActiveTimerList(){
      const active = getActiveTimerEntries();

      $("activeTimersList").innerHTML = active.length ? active.map((entry) => `
        <div class="helper-card">
          <div class="archive-meta-row">
            <div>
              <div class="helper-title">${escapeHTML(entry.key.charAt(0).toUpperCase() + entry.key.slice(1))}</div>
              <div class="helper-copy">${entry.timer.running ? "Running now" : entry.remaining === 0 ? "Finished" : "Paused / adjusted"}</div>
            </div>
            <span class="pill ${entry.timer.running ? "green" : entry.remaining === 0 ? "orange" : ""}">${escapeHTML(formatSeconds(entry.remaining))}</span>
          </div>
        </div>
      `).join("") : `<div class="empty-state">No timers are active yet.</div>`;
    }

    function renderStickyTimerDock(){
      const active = TIMER_KEYS.map((key) => {
        const timer = data.timers[key];
        return { key, remaining: getTimerRemaining(timer), running: timer.running, initial: timer.initial };
      }).filter((entry) => entry.running || (entry.remaining !== entry.initial && entry.remaining > 0));

      const due = getScheduleDecorated().find((item) => item.statusLabel === "Due now") || getScheduleDecorated().find((item) => item.statusLabel === "Next up");

      if (!active.length && !due){
        $("stickyTimerBar").style.display = "none";
        return;
      }

      $("stickyTimerBar").style.display = "block";
      const timerBits = active.slice(0,2).map((entry) => `${entry.key.charAt(0).toUpperCase() + entry.key.slice(1)} ${formatSeconds(entry.remaining)}`);
      const dueBit = due ? `${due.statusLabel}: ${due.item}${due.detailLabel ? ` (${due.detailLabel})` : ""}` : "No boil item flagged";
      $("stickyTimerContent").innerHTML = `
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          ${timerBits.length ? timerBits.map((text) => `<span class="pill green">${escapeHTML(text)}</span>`).join("") : ""}
          <span class="small">${escapeHTML(dueBit)}</span>
        </div>
      `;
    }


    function generateAiPrompt(){
      const b = data.currentBatch;
      const latestGravity = sortedGravityLog()[0] || null;
      const schedule = getScheduleDecorated().slice(0,5).map((item) => `${item.minutesLeft} min left: ${item.item}${item.note ? ` (${item.note})` : ""}`).join("\n");
      return [
        "You are my brew-day assistant for Funcleson Brew Works.",
        "",
        "Help me with recipe creation, troubleshooting, process changes, ingredient substitutions, and brew-day decisions.",
        "",
        `Batch: ${b.name || "Not named yet"}`,
        `Style: ${b.style || "Not set"}`,
        `Type: ${b.type || "Beer"}`,
        `Volume: ${b.volume || "—"} gal`,
        `Target OG/FG/ABV: ${b.og || "—"} / ${b.fg || "—"} / ${b.abv || "—"}`,
        `Latest gravity: ${latestGravity ? `${latestGravity.gravity} (${latestGravity.stage} on ${latestGravity.date})` : "None logged"}`,
        "",
        "Ingredients:",
        b.ingredients || "None entered yet.",
        "",
        "Process:",
        b.process || "None entered yet.",
        "",
        "Brew-day notes:",
        b.notes || "No notes yet.",
        "",
        "Water chemistry:",
        [
          data.waterChemistry.gypsum ? `Gypsum: ${data.waterChemistry.gypsum}g` : "",
          data.waterChemistry.cacl2 ? `CaCl₂: ${data.waterChemistry.cacl2}g` : "",
          data.waterChemistry.epsom ? `Epsom: ${data.waterChemistry.epsom}g` : "",
          data.waterChemistry.lactic ? `Lactic acid: ${data.waterChemistry.lactic}mL` : "",
          data.waterChemistry.phospho ? `Phosphoric acid: ${data.waterChemistry.phospho}mL` : "",
          data.waterChemistry.mashpH ? `Target mash pH: ${data.waterChemistry.mashpH}` : "",
          data.waterChemistry.notes ? `Notes: ${data.waterChemistry.notes}` : ""
        ].filter(Boolean).join(", ") || "None entered yet.",
        "",
        "Upcoming schedule:",
        schedule || "No additions scheduled yet.",
        "",
        "Please answer like an experienced homebrewer. Give me the likely cause, the highest-value fix, and what I should do next."
      ].join("\n");
    }


    function brewMateList(text){
      return String(text || "")
        .split(/[,/\n]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    function brewMateHasKeyword(bag, terms){
      return terms.some((term) => bag.includes(term));
    }

    function brewMateKeywordBag(state){
      return [
        state.conceptName,
        state.style,
        state.inspiration,
        state.vision,
        state.mustHave,
        state.avoid,
        state.adjuncts,
        state.constraints
      ].join(" ").toLowerCase();
    }

    function brewMateBitternessText(mode){
      return {
        soft: "Keep bitterness in the background so it lifts the finish without reading pointy.",
        balanced: "Use bitterness as structure. It should stop sweetness from sagging but never hijack the concept.",
        firm: "This beer wants a firmer spine. Build enough bitterness early that the finish stays defined."
      }[mode || "balanced"] || "Use bitterness as structure.";
    }

    function brewMateBodyText(mode){
      return {
        light: "lean and quick",
        "medium-light": "light but still satisfying",
        medium: "centered through the palate",
        "medium-full": "rounded and plush",
        full: "rich and full"
      }[mode || "medium"] || "centered through the palate";
    }

    function brewMateFinishText(mode){
      return {
        dry: "finishing dry and tidy",
        balanced: "finishing balanced",
        soft: "finishing soft and rounded",
        sweet: "finishing dessert-leaning without turning sticky"
      }[mode || "balanced"] || "finishing balanced";
    }

    function brewMateYeastText(mode){
      return {
        clean: "A clean ferment keeps attention on the grist, hops, and adjunct timing.",
        english: "An English strain adds fruit and softness, so let the recipe breathe and avoid stacking too many sweet malts.",
        belgian: "Belgian yeast should be part of the point, not a surprise guest. Keep the grist simpler so fermentation can speak.",
        lager: "Lager yeast rewards restraint. Every ingredient has to earn its place because flaws show up clearly.",
        hefe: "Hefe strains already bring banana/clove complexity, so specialty malt and hop clutter gets exposed fast.",
        kveik: "Kveik can be useful, but temperature shapes the citrus profile more than many brewers expect."
      }[mode || "clean"] || "Pick a yeast that supports the concept instead of competing with it.";
    }

    function buildBrewMateRecommendations(state){
      const bag = brewMateKeywordBag(state);
      const mustHave = brewMateList(state.mustHave);
      const adjuncts = brewMateList(state.adjuncts);
      const avoid = brewMateList(state.avoid);
      const allFlavors = [...mustHave, ...adjuncts];
      const style = state.style || "custom beer";
      const conceptName = state.conceptName || state.style || "Untitled concept";
      const inspiration = state.inspiration || "no strong external anchor yet";
      const vision = state.vision || "a beer with a clear target and a cleaner finish than its ingredient list suggests";
      const abv = parseMaybeDecimal(state.abv);
      const ibu = parseMaybeDecimal(state.ibu);

      const pairings = [];
      const coach = [];
      const architecture = [];
      const conflicts = [];

      if (brewMateHasKeyword(bag, ["orange", "tangerine", "mandarin", "clementine", "citrus"])){
        pairings.push(["Citrus support", "Orange-leaning beers usually read cleaner when vanilla is soft, bitterness is modest, and yeast stays neutral or lightly expressive rather than spicy."]);
        coach.push(["Orange timing", "Zest or peel in the whirlpool or post-fermentation keeps the beer brighter than relying only on sweet orange extract. A little goes a long way once fermentation is done."]);
      }
      if (brewMateHasKeyword(bag, ["vanilla"])){
        pairings.push(["Vanilla role", "Vanilla works best as a texture amplifier. It makes roast, fruit, and lactose feel rounder even when the dose is not high."]);
        coach.push(["Vanilla handling", "Start lower than your instinct. Vanilla rarely fails by being absent; it fails by flattening the beer into one-note sweetness."]);
        conflicts.push(["Vanilla overload", "Vanilla plus lactose plus sweet finishing gravity can make the beer feel wide and blurry unless bitterness or roast trims the finish."]);
      }
      if (brewMateHasKeyword(bag, ["coffee", "espresso"])){
        pairings.push(["Coffee support", "Coffee usually pairs best with chocolate, light roast, or gentle caramel direction rather than a huge stack of dark crystal sweetness."]);
        coach.push(["Coffee timing", "Cold-side coffee additions tend to read fresher and less harsh than long hot-side contact. Pick coffee that tastes good black first."]);
        conflicts.push(["Coffee harshness", "If roast malt, coffee, and firm bitterness all stack up, the finish can turn acrid instead of elegant."]);
      }
      if (brewMateHasKeyword(bag, ["cacao", "cocoa", "chocolate"])){
        pairings.push(["Chocolate support", "Chocolate notes love restrained roast, a fuller middle palate, and either vanilla or nut accents — but not five dessert flavors at once."]);
        coach.push(["Chocolate choice", "Cacao nibs read drier and darker than many people expect. Sweet chocolate perception usually needs help from the base beer, not just nib quantity."]);
      }
      if (brewMateHasKeyword(bag, ["maple"])){
        pairings.push(["Maple role", "Maple often dries out more than brewers expect. Think of it as aroma and fermentability first, not guaranteed sweetness."]);
        conflicts.push(["Maple expectation gap", "If the whole concept depends on thick maple sweetness, the finished beer may feel thinner than the concept promised unless the malt body carries it."]);
      }
      if (brewMateHasKeyword(bag, ["berry", "blueberry", "raspberry", "strawberry", "blackberry"])){
        pairings.push(["Fruit framing", "Berry beers read cleaner when acidity, dryness, or hop brightness keeps the fruit from feeling jammy and heavy."]);
        coach.push(["Fruit handling", "Real fruit usually gives a better shape than extract alone, but it can thin body and shift acidity. Plan for that, don’t react to it late."]);
      }
      if (brewMateHasKeyword(bag, ["honey"])){
        pairings.push(["Honey role", "Honey lightens body and adds floral lift more reliably than it adds durable sweetness."]);
        coach.push(["Honey timing", "Late-boil or fermentation honey additions preserve more aroma than aggressive boiling."]);
      }
      if (brewMateHasKeyword(bag, ["lactose"])){
        pairings.push(["Lactose support", "Lactose works when it has a job: softening roast, rounding fruit, or building dessert illusion. It should not be your only plan for body."]);
        conflicts.push(["Lactose drag", "Low bitterness plus lactose plus sweet finish is the fastest path to a beer that tastes tired halfway through the glass."]);
      }
      if (brewMateHasKeyword(bag, ["coconut"])){
        pairings.push(["Coconut pairing", "Coconut usually behaves best with chocolate, vanilla, light roast, and a drier finish than most brewers first assume."]);
        coach.push(["Coconut handling", "Toasted coconut can dominate fast. Dose by sensory impact, not by what sounds fun on paper."]);
      }
      if (brewMateHasKeyword(bag, ["oak", "bourbon", "barrel"])){
        pairings.push(["Oak framing", "Oak should sharpen edges and add structure, not simply pile on spirit sweetness."]);
        conflicts.push(["Wood clutter", "Oak, vanilla, roast, and spirit character can all occupy the same aromatic space if you do not decide which one leads."]);
      }
      if (brewMateHasKeyword(bag, ["pepper", "cinnamon", "clove", "spice"])){
        pairings.push(["Spice restraint", "Spices read more elegant when one is clearly leading and the rest support. Mixed-spice beers get muddy quickly."]);
        coach.push(["Spice timing", "Spices are usually easier to layer post-fermentation or in tincture form than to rescue after a heavy hot-side addition."]);
      }

      if (!pairings.length){
        pairings.push(["Anchor", "Pick one lead note, one support note, and one structural note. Great beers usually feel intentional long before they feel complicated."]);
      }

      const bitternessText = brewMateBitternessText(state.bitterness);
      const bodyText = brewMateBodyText(state.body);
      const finishText = brewMateFinishText(state.finish);
      const drinkabilityText = {
        crushable: "Design every choice around the next sip. Trim sweetness, roast weight, and adjunct clutter aggressively.",
        balanced: "Let the first sip be flavorful and the second sip feel easier than expected.",
        sipping: "Intensity is allowed, but every extra layer needs a reason to stay."
      }[state.drinkability || "balanced"] || "Let the beer stay drinkable.";
      const experimentText = {
        classic: "Keep the build grounded. Let process quality and balance do the work.",
        modern: "Use modern flavor ideas, but edit hard. Novelty is not the same as depth.",
        wild: "Push the concept, but still decide what leads, what supports, and what should stay out of the way."
      }[state.experimental || "modern"] || "Use modern flavor ideas, but edit hard.";

      const targetAbv = !Number.isNaN(abv) ? `${abv.toFixed(1)}% ABV` : "an ABV appropriate to the concept";
      const targetIbu = !Number.isNaN(ibu) ? `${ibu.toFixed(0)} IBU` : "bitterness tuned to the finish";

      const baseMalt = brewMateHasKeyword(bag, ["pils", "pilsner", "lager", "saison", "wheat", "citrus", "orange", "lemon"])
        ? "Use a clean base of pilsner or pale malt, with wheat/oats only if the texture needs help."
        : brewMateHasKeyword(bag, ["stout", "porter", "coffee", "chocolate", "maple", "cacao"])
        ? "Use a strong base malt spine and let specialty grains be few but purposeful."
        : "Start with a clean base and only add specialty grains that solve a real flavor or body problem.";

      const specialtyMalt = brewMateHasKeyword(bag, ["stout", "porter", "coffee", "chocolate", "roast"])
        ? "Keep crystal malt more restrained than your first instinct. Layer roast and chocolate with intent so the beer reads precise, not muddy."
        : brewMateHasKeyword(bag, ["citrus", "fruit", "berry", "saison", "pils"])
        ? "Favor lighter specialty touches so the beer keeps brightness and does not collapse into sweetness."
        : "Specialty malt should explain the finish and texture, not just darken the recipe.";

      const hopPlan = brewMateHasKeyword(bag, ["ipa", "pale ale", "citrus", "tropical"])
        ? "Pick whether hops are providing structure, flavor, or aroma leadership. Do not ask one addition to do all three jobs at once."
        : "Use hops to frame the beer more than to steal focus. Early bitterness usually matters more than clever late additions in concept-driven beers.";

      const yeastPlan = brewMateYeastText(state.yeast);

      const adjunctPlan = adjuncts.length
        ? `Adjunct plan: ${adjuncts.join(", ")}. Add ingredients at the stage that matches your goal: kettle for integration, fermentation for transformation, post-fermentation for louder top-note impact.`
        : "No adjuncts listed yet. That is not a weakness. Build the base beer first, then decide whether it truly needs a signature extra.";

      architecture.push(["North star", `Build ${conceptName} as a ${state.drinkability || "balanced"} ${style} inspired by ${inspiration}, aimed at ${vision}. Think ${targetAbv} with ${targetIbu}.`]);
      architecture.push(["Base malt spine", baseMalt]);
      architecture.push(["Specialty grain strategy", specialtyMalt]);
      architecture.push(["Hop structure", `${bitternessText} ${hopPlan}`]);
      architecture.push(["Yeast role", yeastPlan]);
      architecture.push(["Adjunct/timing", adjunctPlan]);
      architecture.push(["Body and finish", `Aim for a beer that feels ${bodyText} while still ${finishText}. BIAB brewers move this more with mash temp and yeast choice than with endless specialty grains.`]);
      architecture.push(["Drinkability lens", `${drinkabilityText} ${experimentText}`]);

      coach.push(["Balance rule", "Lead note, support note, structure. If three ingredients are all trying to be the star, the beer usually loses shape."]);
      coach.push(["Process reminder", "Cold-side oxygen, pitch health, fermentation temperature, and packaging discipline erase more good recipes than creative ingredient choices do."]);

      if (!conflicts.length){
        conflicts.push(["Clarity check", "If the beer still sounds exciting after you remove one non-essential ingredient, that is usually a good sign."]);
      }
      if (allFlavors.length >= 4){
        conflicts.push(["Adjunct crowding", "You already have several loud flavor ideas on the table. Pick a leader, a wingman, and one structural helper or the beer may read cluttered."]);
      }
      if ((state.finish || "") === "sweet" && (state.bitterness || "") === "soft"){
        conflicts.push(["Sweetness imbalance", "Soft bitterness plus sweet finish is risky. Unless acidity, roast, or high attenuation trims it, the beer may feel heavy quickly."]);
      }
      if (avoid.length){
        conflicts.push(["Avoid list reality", `You want to avoid: ${avoid.join(", ")}. Use this as an editing tool whenever a new ingredient idea shows up.`]);
      }
      if ((state.constraints || "").trim()){
        conflicts.push(["Constraint planning", `Constraint: ${state.constraints.trim()}. Design with the limitation from the start so the recipe stays honest.`]);
      }

      const lesson = {
        balance: "Great recipe building is mostly about deciding what the beer should smell like, what it should feel like at mid-palate, and how it should finish. Once that is clear, ingredient choices get easier and restraint gets more obvious.",
        grist: "The best grists are job descriptions, not shopping lists. Base malt sets the stage, body grains change texture, specialty grains add accent, and anything redundant usually steals definition.",
        hops: "Think of hops as three tools: structure, flavor, and aroma. A lot of mediocre recipes happen because brewers blur those jobs together and call it complexity.",
        yeast: "Yeast changes attenuation, fruit expression, dryness, and the amount of work the grain bill has to do. It is one of the biggest design decisions in the recipe, not an afterthought.",
        adjuncts: "Adjuncts become useful when each one solves a specific problem: aroma lift, texture illusion, roast rounding, fruit expression, or dessert framing. They become noise when they are added just because the list sounds exciting.",
        process: "A clean concept can still die in execution. Fermentation control, oxygen discipline, healthy yeast, and sane packaging are what let a clever recipe actually taste intentional."
      }[state.lessonFocus || "balance"] || "Recipe building gets easier when each ingredient has a specific job.";

      const conceptSummary = `${conceptName} should drink like a ${state.drinkability || "balanced"} ${style} with ${targetAbv}, ${targetIbu}, a palate that feels ${bodyText}, and a finish that stays ${finishText}. The inspiration is ${inspiration}, but the real target is ${vision}.`;

      return { conceptSummary, pairings, coach, architecture, conflicts, lesson };
    }

    function renderBrewMateRows(targetId, rows){
      if (!$(targetId)) return;
      $(targetId).innerHTML = (rows || []).map(([label, value]) =>
        `<div class="info-row"><div class="info-row-label">${escapeHTML(label)}</div><div class="info-row-value">${escapeHTML(value)}</div></div>`
      ).join("");
    }

    function renderBrewMate(){
      if (!$("brewMateConceptSummary")) return;
      const state = data.brewMate || clone(defaultData.brewMate);
      const rec = buildBrewMateRecommendations(state);
      $("brewMateConceptSummary").textContent = rec.conceptSummary;
      renderBrewMateRows("brewMatePairings", rec.pairings);
      renderBrewMateRows("brewMateIngredientCoach", rec.coach);
      renderBrewMateRows("brewMateArchitecture", rec.architecture);
      renderBrewMateRows("brewMateConflicts", rec.conflicts);
      if ($("brewMateLesson")) $("brewMateLesson").textContent = rec.lesson;
    }

    function generateBrewMatePrompt(){
      const state = data.brewMate || clone(defaultData.brewMate);
      const rec = buildBrewMateRecommendations(state);
      return [
        "You are BrewMate, my world-class beer recipe mentor.",
        "",
        "Help me brainstorm the beer first, teach me what goes with what and why, warn me about clashes, and then turn it into a disciplined recipe.",
        "",
        `Beer idea name: ${state.conceptName || "Not set"}`,
        `Style anchor: ${state.style || "Not set"}`,
        `Inspiration / vibe: ${state.inspiration || "Not set"}`,
        `Drinking experience: ${state.vision || "Not set"}`,
        `Batch size: ${state.batchSize || "—"} gal`,
        `Target ABV: ${state.abv || "—"}%`,
        `Target IBU: ${state.ibu || "—"}`,
        `Bitterness frame: ${state.bitterness || "balanced"}`,
        `Body: ${state.body || "medium"}`,
        `Finish: ${state.finish || "balanced"}`,
        `Yeast expression: ${state.yeast || "clean"}`,
        `Drinkability target: ${state.drinkability || "balanced"}`,
        `Experimental level: ${state.experimental || "modern"}`,
        `Must-have flavors: ${state.mustHave || "None listed"}`,
        `Avoid flavors: ${state.avoid || "None listed"}`,
        `Adjuncts / signature ingredients: ${state.adjuncts || "None listed"}`,
        `Constraints: ${state.constraints || "None listed"}`,
        `Learning focus: ${state.lessonFocus || "balance"}`,
        "",
        "Current concept north star:",
        rec.conceptSummary,
        "",
        "Please respond in this order:",
        "1) sharpen the concept",
        "2) explain what ingredients and timings support it",
        "3) explain likely clashes or redundancies",
        "4) give me a starter recipe architecture",
        "5) teach me what each major decision is doing"
      ].join("\n");
    }

    function copyBrewMatePrompt(){
      const prompt = generateBrewMatePrompt();
      navigator.clipboard.writeText(prompt).then(() => {
        if ($("copyBrewMatePromptBtn")){
          $("copyBrewMatePromptBtn").textContent = "Copied";
          setTimeout(() => { if ($("copyBrewMatePromptBtn")) $("copyBrewMatePromptBtn").textContent = "Copy deep-dive prompt"; }, 1200);
        }
      }).catch(() => alert("Could not copy BrewMate prompt."));
    }

    function loadBrewMateInputs(source){
      if (!$("brewMateStyle")) return;
      const payload = { ...clone(defaultData.brewMate), ...(source || data.brewMate || {}) };
      if ($("brewMateConceptName")) $("brewMateConceptName").value = payload.conceptName || "";
      $("brewMateStyle").value = payload.style || "";
      if ($("brewMateInspiration")) $("brewMateInspiration").value = payload.inspiration || "";
      $("brewMateVision").value = payload.vision || "";
      $("brewMateBatchSize").value = payload.batchSize || "";
      $("brewMateAbv").value = payload.abv || "";
      $("brewMateIbu").value = payload.ibu || "";
      if ($("brewMateBitterness")) $("brewMateBitterness").value = payload.bitterness || "balanced";
      $("brewMateBody").value = payload.body || "medium";
      $("brewMateFinish").value = payload.finish || "balanced";
      $("brewMateYeast").value = payload.yeast || "clean";
      if ($("brewMateTargetDrinkability")) $("brewMateTargetDrinkability").value = payload.drinkability || "balanced";
      if ($("brewMateExperimental")) $("brewMateExperimental").value = payload.experimental || "modern";
      if ($("brewMateMustHave")) $("brewMateMustHave").value = payload.mustHave || "";
      if ($("brewMateAvoid")) $("brewMateAvoid").value = payload.avoid || "";
      $("brewMateAdjuncts").value = payload.adjuncts || "";
      $("brewMateConstraints").value = payload.constraints || "";
      $("brewMateLessonFocus").value = payload.lessonFocus || "balance";
    }

    function saveBrewMateFromInputs(){
      if (!$("brewMateStyle")) return;
      data.brewMate = {
        conceptName: $("brewMateConceptName")?.value.trim() || "",
        style: $("brewMateStyle").value.trim(),
        inspiration: $("brewMateInspiration")?.value.trim() || "",
        vision: $("brewMateVision").value.trim(),
        batchSize: $("brewMateBatchSize").value,
        abv: $("brewMateAbv").value,
        ibu: $("brewMateIbu").value,
        bitterness: $("brewMateBitterness")?.value || "balanced",
        body: $("brewMateBody").value,
        finish: $("brewMateFinish").value,
        yeast: $("brewMateYeast").value,
        drinkability: $("brewMateTargetDrinkability")?.value || "balanced",
        experimental: $("brewMateExperimental")?.value || "modern",
        mustHave: $("brewMateMustHave")?.value.trim() || "",
        avoid: $("brewMateAvoid")?.value.trim() || "",
        adjuncts: $("brewMateAdjuncts").value.trim(),
        constraints: $("brewMateConstraints").value.trim(),
        lessonFocus: $("brewMateLessonFocus").value
      };
      persistData();
      renderBrewMate();
    }

    function clearBrewMateInputs(){
      data.brewMate = clone(defaultData.brewMate);
      loadBrewMateInputs(data.brewMate);
      persistData();
      renderBrewMate();
    }

    function brewMateBitternessFromIbu(value){
      const ibu = parseMaybeDecimal(value);
      if (Number.isNaN(ibu)) return "balanced";
      if (ibu <= 20) return "soft";
      if (ibu >= 45) return "firm";
      return "balanced";
    }

    function seedBrewMateFromRecipe(recipe){
      if (!recipe) return;
      const processText = (recipe.process || recipe.notes || "").toLowerCase();
      const adjunctNames = (recipe.sections?.otherIngredients || []).map((row) => row.name).filter(Boolean).join(", ");
      const seeded = {
        ...clone(defaultData.brewMate),
        ...(data.brewMate || {}),
        conceptName: recipe.name || "",
        style: recipe.style || recipe.name || "",
        inspiration: recipe.quick || "",
        vision: (recipe.process || recipe.notes || "").slice(0, 180),
        batchSize: recipe.volume || "",
        abv: recipe.abv || computedAbvValue(recipe.og, recipe.fg) || "",
        ibu: data.brewMate?.ibu || "",
        bitterness: brewMateBitternessFromIbu(data.brewMate?.ibu || ""),
        mustHave: adjunctNames,
        adjuncts: adjunctNames,
        constraints: processText.includes("biab") ? "BIAB only" : (data.brewMate?.constraints || "")
      };
      data.brewMate = seeded;
      loadBrewMateInputs(seeded);
      persistData();
      renderBrewMate();
      setActiveTab("brewmate");
    }

    function seedBrewMateFromBatch(batch){
      if (!batch) return;
      const seeded = {
        ...clone(defaultData.brewMate),
        ...(data.brewMate || {}),
        conceptName: batch.name || "",
        style: batch.style || batch.name || "",
        inspiration: batch.type || "",
        vision: (batch.notes || batch.process || "").slice(0, 180),
        batchSize: batch.volume || "",
        abv: batch.abv || computedAbvValue(batch.og, batch.fg) || "",
        adjuncts: batch.ingredients || "",
        mustHave: batch.ingredients || "",
        constraints: batch.biab?.hasPlan ? "BIAB workflow" : (data.brewMate?.constraints || "")
      };
      data.brewMate = seeded;
      loadBrewMateInputs(seeded);
      persistData();
      renderBrewMate();
      setActiveTab("brewmate");
    }

    function buildStarterRecipeFromBrewMate(state){
      const abv = Number.isNaN(parseMaybeDecimal(state.abv)) ? 6 : parseMaybeDecimal(state.abv);
      const finishPtsBase = { dry: 8, balanced: 12, soft: 15, sweet: 18 }[state.finish || "balanced"] || 12;
      const bodyAdjust = { light: -2, "medium-light": -1, medium: 0, "medium-full": 2, full: 4 }[state.body || "medium"] || 0;
      const fgPts = Math.max(6, finishPtsBase + bodyAdjust);
      const ogPts = Math.max(fgPts + 20, Math.round(fgPts + ((abv / 131.25) * 1000)));
      const og = (1 + ogPts / 1000).toFixed(3);
      const fg = (1 + fgPts / 1000).toFixed(3);
      const bitterness = state.bitterness || brewMateBitternessFromIbu(state.ibu);
      const style = state.style || "Custom beer";
      const recipeName = state.conceptName || style || "BrewMate draft";
      const mustHave = brewMateList(state.mustHave);
      const adjuncts = brewMateList(state.adjuncts);
      const bag = brewMateKeywordBag(state);

      let fermentables = [{ name: "Pale malt", amount: "8", unit: "lb", lovibond: "", percent: "78" }];
      if (brewMateHasKeyword(bag, ["pils", "pilsner", "lager", "saison"])) fermentables = [{ name: "Pilsner malt", amount: "8", unit: "lb", lovibond: "", percent: "82" }];
      if (brewMateHasKeyword(bag, ["wheat", "hefe", "orange", "citrus"])){
        fermentables = [
          { name: "Pale malt", amount: "6.5", unit: "lb", lovibond: "", percent: "62" },
          { name: "Wheat malt", amount: "3", unit: "lb", lovibond: "", percent: "28" },
          { name: "Flaked oats", amount: "0.75", unit: "lb", lovibond: "", percent: "7" }
        ];
      }
      if (brewMateHasKeyword(bag, ["stout", "porter", "coffee", "chocolate", "cacao", "maple"])){
        fermentables = [
          { name: "Pale malt", amount: "8.5", unit: "lb", lovibond: "", percent: "75" },
          { name: "Munich malt", amount: "1.25", unit: "lb", lovibond: "9", percent: "11" },
          { name: "Chocolate malt", amount: "0.5", unit: "lb", lovibond: "350", percent: "4" },
          { name: "Roasted barley", amount: "0.35", unit: "lb", lovibond: "500", percent: "3" },
          { name: "Crystal 60", amount: "0.5", unit: "lb", lovibond: "60", percent: "4" }
        ];
      }

      let hops = [{ name: "Magnum", amount: bitterness === "firm" ? "0.8" : "0.45", unit: "oz", time: "60", use: "Boil" }];
      if (brewMateHasKeyword(bag, ["ipa", "pale ale", "citrus", "orange", "tropical"])){
        hops = [
          { name: "Magnum", amount: bitterness === "firm" ? "0.65" : "0.4", unit: "oz", time: "60", use: "Boil" },
          { name: "Cascade", amount: "1", unit: "oz", time: "10", use: "Boil" },
          { name: "Citra", amount: "1.5", unit: "oz", time: "5", use: "Whirlpool" }
        ];
      }
      if (brewMateHasKeyword(bag, ["lager", "pils", "noble"])){
        hops = [
          { name: "Hallertau Mittelfrüh", amount: bitterness === "firm" ? "1.2" : "0.85", unit: "oz", time: "60", use: "Boil" },
          { name: "Saaz", amount: "1", unit: "oz", time: "10", use: "Boil" }
        ];
      }

      let yeast = [{ name: "US-05", amount: "1", unit: "packet", timing: "Primary" }];
      if ((state.yeast || "") === "english") yeast = [{ name: "English ale yeast", amount: "1", unit: "packet", timing: "Primary" }];
      if ((state.yeast || "") === "belgian") yeast = [{ name: "Belgian abbey / saison yeast", amount: "1", unit: "packet", timing: "Primary" }];
      if ((state.yeast || "") === "lager") yeast = [{ name: "Lager yeast", amount: "2", unit: "packets", timing: "Primary" }];
      if ((state.yeast || "") === "hefe") yeast = [{ name: "Hefeweizen yeast", amount: "1", unit: "packet", timing: "Primary" }];
      if ((state.yeast || "") === "kveik") yeast = [{ name: "Kveik yeast", amount: "1", unit: "packet", timing: "Primary" }];

      const otherIngredients = adjuncts.map((name) => {
        const lower = name.toLowerCase();
        let timing = "Post-fermentation / to taste";
        if (["cacao nibs","cocoa nibs","coffee","espresso","vanilla"].some((k) => lower.includes(k))) timing = "Post-fermentation / to taste";
        if (["orange peel","zest","coriander","spice","cinnamon"].some((k) => lower.includes(k))) timing = "Whirlpool / late boil";
        if (["honey","maple"].some((k) => lower.includes(k))) timing = "Late boil or fermentation";
        return { name, amount: "", unit: "", timing };
      });
      if (!otherIngredients.length && mustHave.length){
        mustHave.forEach((name) => otherIngredients.push({ name, amount: "", unit: "", timing: "Add only if it sharpens the concept" }));
      }

      const mashTemp = { light: "149", "medium-light": "150", medium: "152", "medium-full": "154", full: "156" }[state.body || "medium"] || "152";
      const mashTime = "60";
      const boilTime = "60";
      const notes = [
        `BrewMate concept: ${state.conceptName || style}`,
        `Target drinking experience: ${state.vision || "Clarify the beer's center of gravity before piling on extras."}`,
        `Inspiration: ${state.inspiration || "None entered"}`,
        `Must-have flavors: ${state.mustHave || "None listed"}`,
        `Avoid: ${state.avoid || "None listed"}`,
        `Bitterness frame: ${bitterness}`,
        `Experimental level: ${state.experimental || "modern"}`,
        "Starter draft only — tighten percentages, adjunct dosing, and process once you decide what should lead and what should support."
      ].join("\n");

      return {
        name: recipeName,
        style,
        type: "Beer",
        volume: state.batchSize || "5",
        og,
        fg,
        process: notes,
        tags: ["BrewMate"],
        sections: normalizeRecipeSections({
          fermentables,
          hops,
          yeast,
          otherIngredients,
          mashGuidelines: {
            temp: mashTemp,
            time: mashTime,
            boilTime,
            boilOff: "1.0",
            trub: "0.5",
            absorption: "0.125",
            grainTemp: "70",
            ratio: "",
            spargeTemp: "",
            notes: `BrewMate starter recipe. ${brewMateBitternessText(bitterness)}`
          },
          defaults: {
            schedule: [],
            timers: {
              mash: { initial: Number(mashTime) * 60, remaining: Number(mashTime) * 60, running: false, lastStarted: null, finishedAt: null },
              boil: { initial: Number(boilTime) * 60, remaining: Number(boilTime) * 60, running: false, lastStarted: null, finishedAt: null }
            },
            packaging: null
          }
        })
      };
    }

    function seedRecipeFromBrewMate(){
      saveBrewMateFromInputs();
      const draft = buildStarterRecipeFromBrewMate(data.brewMate || clone(defaultData.brewMate));
      clearRecipeEditor();
      $("templateName").value = draft.name || "";
      $("templateStyle").value = draft.style || "";
      $("templateType").value = "Beer";
      $("templateVolume").value = draft.volume || "";
      $("templateOG").value = draft.og || "";
      $("templateFG").value = draft.fg || "";
      $("templateProcess").value = draft.process || "";
      $("templateTags").value = Array.isArray(draft.tags) ? draft.tags.join(", ") : "BrewMate";
      setRecipeEditorSections(draft.sections || defaultRecipeSections());
      window.recipeDraftDefaults = clone((draft.sections || {}).defaults || defaultRecipeSections().defaults);
      updateRecipeDefaultsUi(window.recipeDraftDefaults);
      data.ui.editingRecipeId = null;
      if ($("saveTemplateBtn")) $("saveTemplateBtn").textContent = "Save recipe";
      if ($("recipeEditorTitle")) $("recipeEditorTitle").textContent = "Build a recipe";
      if ($("cancelRecipeEditBtn")) $("cancelRecipeEditBtn").hidden = true;
      syncRecipeAbvField();
      renderRecipeBiabPlanner();
      persistData();
      setActiveTab("recipes");
    }

    function bindBrewMate(){
      const ids = ["brewMateConceptName","brewMateStyle","brewMateInspiration","brewMateVision","brewMateBatchSize","brewMateAbv","brewMateIbu","brewMateBitterness","brewMateBody","brewMateFinish","brewMateYeast","brewMateTargetDrinkability","brewMateExperimental","brewMateMustHave","brewMateAvoid","brewMateAdjuncts","brewMateConstraints","brewMateLessonFocus"];
      ids.forEach((id) => {
        if (!$(id)) return;
        $(id).addEventListener("input", saveBrewMateFromInputs);
        $(id).addEventListener("change", saveBrewMateFromInputs);
      });
      if ($("copyBrewMatePromptBtn")) $("copyBrewMatePromptBtn").onclick = copyBrewMatePrompt;
      if ($("openBrewMateChatgptBtn")) $("openBrewMateChatgptBtn").onclick = () => window.open("https://chatgpt.com", "_blank", "noopener,noreferrer");
      if ($("brewMateClearBtn")) $("brewMateClearBtn").onclick = clearBrewMateInputs;
      if ($("brewMateSeedRecipeBtn")) $("brewMateSeedRecipeBtn").onclick = seedRecipeFromBrewMate;
      if ($("brewMateLoadRecipeBtn")) $("brewMateLoadRecipeBtn").onclick = () => {
        const recipe = data.recipes.find((item) => item.id === data.selectedRecipeId);
        if (!recipe) return alert("Select a recipe first.");
        seedBrewMateFromRecipe(recipe);
      };
      if ($("brewMateLoadBatchBtn")) $("brewMateLoadBatchBtn").onclick = () => {
        if (!data.currentBatch?.name) return alert("Load a live batch first.");
        seedBrewMateFromBatch(data.currentBatch);
      };
      loadBrewMateInputs(data.brewMate);
      renderBrewMate();
    }

    function copyAiPrompt(){
      const prompt = generateAiPrompt();
      navigator.clipboard.writeText(prompt).then(() => {
        ["copyAiPromptBtn","copyAiPromptBtnLibrary"].forEach((id) => {
          if ($(id)){
            $(id).textContent = "Copied";
            setTimeout(() => { if ($(id)) $(id).textContent = "Copy AI prompt"; }, 1200);
          }
        });
      }).catch(() => alert("Could not copy AI prompt."));
    }

    function renderDashboard(){
      const b = data.currentBatch;
      const schedule = getScheduleDecorated();
      const dueNow = schedule.filter((item) => item.statusLabel === "Due now");
      const overdue = schedule.filter((item) => item.statusLabel === "Overdue");
      const nextUp = schedule.find((item) => item.statusLabel === "Next up");
      const latestGravity = sortedGravityLog()[0] || null;
      const previousGravity = sortedGravityLog()[1] || null;
      const actualOg = getActualOg();
      const attenuation = latestGravity && actualOg ? calcAttenuation(actualOg, Number(latestGravity.gravity)) : null;
      const abvToDate = latestGravity && actualOg ? calcABV(actualOg, Number(latestGravity.gravity)) : null;
      const checklist = data.checklists[data.activeChecklistType] || [];
      const checklistDone = checklist.filter((item) => item.done).length;
      const checklistPct = checklist.length ? Math.round((checklistDone / checklist.length) * 100) : 0;
      const nextChecklistItem = checklist.find((item) => !item.done) || null;
      const activeTimers = getActiveTimerEntries();
      const packagingList = data.packaging.checklists[data.packaging.type] || [];
      const packagingDone = packagingList.filter((item) => item.done).length;
      const est = calcABV(b.og, b.fg);
      const latestTrend = latestGravity && previousGravity ? ((Number(latestGravity.gravity) - Number(previousGravity.gravity)) * 1000) : null;
      const urgentTimer = activeTimers.filter((entry) => entry.timer.running).sort((a,b) => a.remaining - b.remaining)[0] || null;
      const hasBatch = Boolean((b.name || "").trim() || (b.style || "").trim() || b.og || b.ingredients || b.notes);

      $("dashboardStats").innerHTML = [
        { label: "Batch", value: hasBatch ? escapeHTML(b.name || "Unnamed batch") : "No active brew", copy: hasBatch ? escapeHTML(`${b.style || "No style"} · ${b.volume ? `${b.volume} gal` : "No size"}`) : "Start a batch when you are ready" },
        { label: "Checklist", value: `${checklistDone}/${checklist.length || 0}`, copy: `${checklistPct}% complete` },
        { label: "Latest gravity", value: latestGravity ? Number(latestGravity.gravity).toFixed(3) : "—", copy: latestGravity ? `${latestGravity.stage} · ${latestGravity.date}` : "No reading logged" },
        { label: "Timers", value: String(activeTimers.length), copy: activeTimers.length ? `${activeTimers.filter((entry) => entry.timer.running).length} running` : "Quiet right now" }
      ].map((item) => `
        <div class="dashboard-stat">
          <div class="helper-label">${item.label}</div>
          <div class="dashboard-stat-value">${item.value}</div>
          <div class="dashboard-stat-copy">${item.copy}</div>
        </div>
      `).join("");

      let primaryAction = hasBatch ? "Bench looks quiet right now." : "Start a fresh batch when you are brewing.";
      let secondaryAction = hasBatch ? "Use notes, timers, or packaging when you are ready." : "Until then, keep this dashboard clean or build recipes in Recipes.";
      let actionTone = "pill green";
      if (!hasBatch){
        actionTone = "pill blue";
      } else if (overdue.length){
        primaryAction = `${overdue[0].item} is overdue.`;
        secondaryAction = overdue[0].note || overdue[0].detailLabel || "Open the timer tab and catch up the schedule.";
        actionTone = "pill berry";
      } else if (dueNow.length){
        primaryAction = `Do now: ${dueNow[0].item}`;
        secondaryAction = dueNow[0].note || dueNow[0].detailLabel || "This addition is due now.";
        actionTone = "pill red";
      } else if (urgentTimer && urgentTimer.remaining <= 300){
        primaryAction = `${urgentTimer.key.charAt(0).toUpperCase() + urgentTimer.key.slice(1)} timer needs attention soon.`;
        secondaryAction = `${formatSeconds(urgentTimer.remaining)} left.`;
        actionTone = "pill orange";
      } else if (nextUp){
        primaryAction = `Coming up: ${nextUp.item}`;
        secondaryAction = nextUp.detailLabel || "Next scheduled addition.";
        actionTone = "pill blue";
      } else if (nextChecklistItem){
        primaryAction = `Next checklist item: ${nextChecklistItem.text}`;
        secondaryAction = `${checklistDone}/${checklist.length || 0} complete.`;
      }

      $("dashboardNextMove").innerHTML = `
        <span class="${actionTone}">Next</span>
        <div style="height:10px"></div>
        <div class="priority-title">${escapeHTML(primaryAction)}</div>
        <div class="priority-copy">${escapeHTML(secondaryAction)}</div>
      `;

      $("dashboardBatchPulse").innerHTML = hasBatch ? `
        <strong style="color:var(--cream)">${escapeHTML(b.name || "Unnamed batch")}</strong><br>
        <span class="small">${escapeHTML(b.type || "—")} · ${escapeHTML(b.style || "—")} · ${b.volume ? `${escapeHTML(String(b.volume))} gal` : "—"}</span>
        <div style="height:12px"></div>
        <div>Target OG <strong style="color:var(--cream)">${b.og ? escapeHTML(Number(b.og).toFixed(3)) : "—"}</strong> · Target FG <strong style="color:var(--cream)">${b.fg ? escapeHTML(Number(b.fg).toFixed(3)) : "—"}</strong> · Est ABV <strong style="color:var(--cream)">${est ? escapeHTML(est.toFixed(2) + "%") : (b.abv ? escapeHTML(Number(b.abv).toFixed(2) + "%") : "—")}</strong></div>
        <div style="height:10px"></div>
        <div>${escapeHTML((b.notes || "No running notes yet.").slice(0, 180))}${(b.notes || "").length > 180 ? "…" : ""}</div>
      ` : `<div class="empty-state">No active brew loaded. Use Brew Day to start one, or save recipe recipes in Recipes first.</div>`;

      const urgentBits = [];
      if (!hasBatch){
        urgentBits.push("<div class='empty-state'>Nothing urgent because there is no live batch yet.</div>");
      } else if (overdue.length){
        urgentBits.push(overdue.slice(0,2).map((item) => `<div><span class="pill berry">Overdue</span> ${escapeHTML(item.item)} ${item.note ? `<span class="small">${escapeHTML(item.note)}</span>` : ""}</div>`).join("<div style='height:8px'></div>"));
      } else if (dueNow.length){
        urgentBits.push(dueNow.map((item) => `<div><span class="pill red">Due now</span> ${escapeHTML(item.item)} ${item.note ? `<span class="small">${escapeHTML(item.note)}</span>` : ""}</div>`).join("<div style='height:8px'></div>"));
      } else if (nextUp){
        urgentBits.push(`<div><span class="pill blue">Next up</span> ${escapeHTML(nextUp.item)} <span class="small">${escapeHTML(nextUp.detailLabel)}</span></div>`);
      } else {
        urgentBits.push("<div>No additions are being flagged right now.</div>");
      }
      urgentBits.push(`<div style="height:12px"></div><div class="small">Timers ${activeTimers.length ? activeTimers.map((entry) => `${entry.key.charAt(0).toUpperCase() + entry.key.slice(1)} ${formatSeconds(entry.remaining)}`).map(escapeHTML).join(" · ") : "quiet right now"}</div>`);
      $("dashboardUrgent").innerHTML = urgentBits.join("");

      if ($("dashboardTimerList")) $("dashboardTimerList").innerHTML = activeTimers.length ? activeTimers.map((entry) => `
        <div class="helper-card">
          <div class="archive-meta-row">
            <div>
              <div class="helper-title">${escapeHTML(entry.key.charAt(0).toUpperCase() + entry.key.slice(1))}</div>
              <div class="helper-copy">${entry.timer.running ? "Running" : entry.remaining === 0 ? "Finished" : "Paused"}</div>
            </div>
            <span class="pill ${entry.timer.running ? "green" : entry.remaining === 0 ? "orange" : "blue"}">${escapeHTML(formatSeconds(entry.remaining))}</span>
          </div>
        </div>
      `).join("") : `<div class="empty-state">No timers are active.</div>`;

      if ($("dashboardGravitySummary")) $("dashboardGravitySummary").innerHTML = `
        <div>Actual OG <strong style="color:var(--cream)">${actualOg ? escapeHTML(Number(actualOg).toFixed(3)) : "—"}</strong></div>
        <div style="height:8px"></div>
        <div>Latest <strong style="color:var(--cream)">${latestGravity ? escapeHTML(Number(latestGravity.gravity).toFixed(3)) : "—"}</strong>${latestGravity ? ` <span class="small">${escapeHTML(latestGravity.stage)} · ${escapeHTML(latestGravity.date)}</span>` : ""}</div>
        <div style="height:8px"></div>
        <div>Trend <strong style="color:var(--cream)">${latestTrend == null ? "—" : escapeHTML(`${latestTrend > 0 ? "+" : ""}${latestTrend.toFixed(0)} pts`)}</strong>${previousGravity ? ` <span class="small">vs ${escapeHTML(previousGravity.stage)} ${escapeHTML(Number(previousGravity.gravity).toFixed(3))}</span>` : ""}</div>
        <div style="height:8px"></div>
        <div>Attenuation / ABV-to-date <strong style="color:var(--cream)">${attenuation == null ? "—" : escapeHTML(`${attenuation.toFixed(1)}% · ${abvToDate ? abvToDate.toFixed(2) : "0.00"}%`)}</strong></div>
      `;

      if ($("dashboardArchiveSummary")) $("dashboardArchiveSummary").innerHTML = hasBatch ? `
        <div>Packaging mode <strong style="color:var(--cream)">${escapeHTML(data.packaging.type.charAt(0).toUpperCase() + data.packaging.type.slice(1))}</strong></div>
        <div style="height:8px"></div>
        <div>Packaging checklist <strong style="color:var(--cream)">${packagingDone}/${packagingList.length || 0}</strong></div>
        <div style="height:8px"></div>
        <div>Archive ready <strong style="color:var(--cream)">${packagingDone === (packagingList.length || 0) && packagingList.length ? "Yes" : "Not yet"}</strong></div>
        <div style="height:8px"></div>
        <div>${escapeHTML((data.packaging.notes || "Keep packaging notes in Packaging until this batch is ready to archive.").slice(0, 140))}</div>
      ` : `<div class="empty-state">Finish checks appear here when a live batch is loaded.</div>`;

      const widgets = data.ui.dashboardWidgets || {};
      document.body.classList.toggle("compact-mode", Boolean(data.ui.compactMode));
      const map = {
        stats: "dashboard-card-stats",
        batch: "dashboard-card-batch",
        urgent: "dashboard-card-urgent",
        timers: "dashboard-card-timers",
        gravity: "dashboard-card-gravity",
        finish: "dashboard-card-finish"
      };
      Object.entries(map).forEach(([key, id]) => {
        if ($(id)) $(id).style.display = widgets[key] === false ? "none" : "";
      });
      document.querySelectorAll("[data-dash-widget]").forEach((input) => {
        input.checked = widgets[input.dataset.dashWidget] !== false;
      });

      if ($("dashboardAiSummary")) $("dashboardAiSummary").textContent = generateAiPrompt();
    }

    function renderTimers(){
      TIMER_KEYS.forEach((key) => {
        const timer = data.timers[key];
        const remaining = getTimerRemaining(timer);
        $(`${key}Clock`).textContent = formatSeconds(remaining);
        const durationInput = $(`${key}Duration`);
        if (durationInput && document.activeElement !== durationInput){
          durationInput.value = Math.round(timer.initial / 60);
        }

        const card = $(`${key}TimerCard`);
        const status = $(`${key}Status`);
        card.classList.remove("running","finished");

        if (timer.running){
          card.classList.add("running");
          status.textContent = "Running";
          status.className = "pill green";
        } else if (remaining === 0){
          card.classList.add("finished");
          status.textContent = "Finished";
          status.className = "pill orange";
        } else if (remaining !== timer.initial){
          status.textContent = "Paused";
          status.className = "pill blue";
        } else {
          status.textContent = "Ready";
          status.className = "pill";
        }
      });
      renderActiveTimerList();
    }


    function renderRecipeBiabPlanner(){
      const summaryEl = $("recipeBiabTargetSummary");
      const quickEl = $("recipeBiabQuickSummary");
      const resultEl = $("recipeBiabResult");
      if (!summaryEl || !quickEl || !resultEl) return;

      const sections = {
        ...getRecipeEditorSections(),
        fermentables: normalizeRecipeSectionRowsFromDom("fermentables"),
        mashGuidelines: {
          temp: $("templateMashTemp")?.value || "",
          time: $("templateMashTime")?.value || "",
          boilTime: $("templateBiabBoilTime")?.value || "",
          boilOff: $("templateBiabBoilOff")?.value || "",
          trub: $("templateBiabTrub")?.value || "",
          absorption: $("templateBiabAbsorption")?.value || "",
          grainTemp: $("templateBiabGrainTemp")?.value || "",
          notes: $("templateMashNotes")?.value || ""
        }
      };
      const plan = buildBiabPlan(sections, $("templateVolume")?.value);

      summaryEl.innerHTML = `Recipe size: <strong style="color:var(--cream)">${plan.batchSize != null ? `${plan.batchSize.toFixed(2)} gal` : "—"}</strong> · Grain bill: <strong style="color:var(--cream)">${plan.grainLb != null ? formatWeightLb(plan.grainLb) : "—"}</strong>`;

      if (!plan.hasPlan){
        quickEl.textContent = "Add a target size and fermentables to unlock the BIAB planner.";
        resultEl.textContent = "Add target size and fermentables to see total BIAB water, pre-boil volume, and strike temp.";
        return;
      }

      quickEl.innerHTML = `${plan.ratio != null ? `Mash thickness: <strong style="color:var(--cream)">${plan.ratio.toFixed(2)} qt/lb</strong>` : "Mash thickness pending"} · ${plan.mashVolume != null ? `Mash volume: <strong style="color:var(--cream)">${plan.mashVolume.toFixed(2)} gal</strong>` : "Mash volume pending"}`;
      resultEl.innerHTML = `
        <div style="display:grid;gap:4px;line-height:1.6">
          <div>Total water needed: <strong style="color:var(--cream)">${plan.totalWater.toFixed(2)} gal</strong></div>
          <div>Pre-boil wort: <strong style="color:var(--cream)">${plan.preBoilVol.toFixed(2)} gal</strong></div>
          <div>Post-boil volume: <strong style="color:var(--cream)">${plan.postBoilVol.toFixed(2)} gal</strong></div>
          ${plan.strikeTemp != null ? `<div>Strike water temp: <strong style="color:var(--cream)">${plan.strikeTemp.toFixed(1)}°F</strong>${plan.mashTime != null ? ` · ${plan.mashTime.toFixed(0)} min mash` : ""}</div>` : `<div>Enter mash temp and grain temp to calculate strike water temp.</div>`}
          <div class="small" style="margin-top:2px">Grain absorption: ${plan.grainLb != null && plan.absorption != null ? (plan.grainLb * plan.absorption).toFixed(2) : "0.00"} gal · Boiloff: ${plan.batchSize != null && plan.boilOffRate != null && plan.boilTime != null ? (plan.boilOffRate * (plan.boilTime / 60)).toFixed(2) : "0.00"} gal · Trub: ${plan.trub != null ? plan.trub.toFixed(2) : "0.00"} gal</div>
        </div>
      `;
    }

    function renderCalcs(){
      const og = Number($("calcOg").value);
      const fg = Number($("calcFg").value);
      const abv = calcABV(og, fg);
      $("abvResult").textContent = abv ? `Estimated ABV: ${abv.toFixed(2)}%` : "Enter OG and FG";

      const pv = Number($("primeVol").value);
      const pt = Number($("primeTemp").value);
      const pc = Number($("primeCo2").value);
      const priming = calculatePrimingSugarCorn({ volumeGallons: pv, beerTempF: pt, targetVolumesCo2: pc });
      if (priming){
        $("primeResult").textContent = priming.neededVolumes <= 0
          ? "Already over target at this temp."
          : `Corn sugar: ${priming.cornSugarOz.toFixed(2)} oz (${priming.cornSugarGrams.toFixed(0)} g)`;
      } else {
        $("primeResult").textContent = "Enter values";
      }

      /* Yeast Starter Calculator */
      const stOG = Number($("starterOG").value);
      const stVol = Number($("starterVol").value);
      const stType = $("starterType").value;
      const stPacks = Number($("starterPacks").value) || 1;
      const starter = calculateStarterRecommendation({
        og: stOG,
        volumeGallons: stVol,
        beerType: stType,
        packs: stPacks
      });

      if (starter){
        if (!starter.needsStarter){
          $("starterResult").innerHTML = `
            Cells needed: <strong style="color:var(--cream)">${starter.cellsNeededBillions.toFixed(0)}B</strong> · You have: <strong style="color:var(--cream)">${starter.cellsAvailableBillions.toFixed(0)}B</strong><br>
            <span class="pill green">No starter needed</span> — ${stPacks} pack${stPacks === 1 ? "" : "s"} provides enough cells at ${starter.plato.toFixed(1)}°P.
          `;
        } else {
          $("starterResult").innerHTML = `
            Cells needed: <strong style="color:var(--cream)">${starter.cellsNeededBillions.toFixed(0)}B</strong> · You have: <strong style="color:var(--cream)">${starter.cellsAvailableBillions.toFixed(0)}B</strong> · Deficit: <strong style="color:var(--cream)">${starter.deficitBillions.toFixed(0)}B</strong><br>
            Recommended starter: ~<strong style="color:var(--cream)">${starter.recommendedStarterLiters.toFixed(1)}L</strong> with <strong style="color:var(--cream)">${starter.dmeGrams.toFixed(0)}g DME</strong> on a stir plate.<br>
            <span class="small">${stType === "lager" ? "Lager" : "Ale"} rate: ${starter.pitchRateMCellsPerMlPerPlato}M cells/mL/°P · Wort: ${starter.plato.toFixed(1)}°P · ${stPacks} pack${stPacks === 1 ? "" : "s"}</span>
          `;
        }
      } else {
        $("starterResult").textContent = "Enter OG and volume to see pitching needs.";
      }
    }


    function getPackagingReadiness(){
      const packagingList = data.packaging.checklists[data.packaging.type] || [];
      const packagingDone = packagingList.filter((item) => item.done).length;
      const readinessChecks = [
        Boolean((data.currentBatch.name || '').trim()),
        packagingList.length ? packagingDone === packagingList.length : false,
        Boolean((data.packaging.notes || '').trim()),
        Boolean((data.packaging.tastingNotes || '').trim() || data.packaging.rating),
        Boolean((data.currentBatch.fg || '').toString().trim() || sortedGravityLog().some((entry) => entry.stage === 'FG'))
      ];
      return { done: packagingDone, total: packagingList.length, score: readinessChecks.filter(Boolean).length, max: readinessChecks.length };
    }

    function clearCurrentBatch(){
      if (!confirm('Clear the current live batch and packaging notes? Your saved recipes and archive will stay intact.')) return;
      data.currentBatch = clone(defaultData.currentBatch);
      data.gravityLog = [];
      data.schedule = [];
      data.brewElapsed = clone(defaultData.brewElapsed);
      data.packaging = clone(defaultData.packaging);
      data.timers = clone(defaultData.timers);
      data.waterChemistry = clone(defaultData.waterChem);
      data.waterChem = clone(defaultData.waterChem);
      persistData();
      initRender();
      setActiveTab('recipes');
    }

    function createRecipeFromArchive(item){
      const archivedPlan = item.biabPlan || null;
      const recipe = {
        id: makeId('recipe'),
        name: `${item.name || 'Archived batch'} rebrew`,
        style: item.style || '',
        type: item.type || 'Beer',
        volume: item.volume || '',
        og: item.og || '',
        fg: item.fg || '',
        abv: item.abv || computedAbvValue(item.og, item.fg) || '',
        notes: item.notes || item.tastingNotes || '',
        quick: item.notes || item.tastingNotes || '',
        ingredients: item.ingredients || '',
        process: item.process || '',
        tags: (item.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
        sections: {
          ...defaultRecipeSections(),
          mashGuidelines: archivedPlan ? {
            temp: archivedPlan.mashTemp != null ? String(archivedPlan.mashTemp) : "",
            time: archivedPlan.mashTime != null ? String(archivedPlan.mashTime) : "",
            boilTime: archivedPlan.boilTime != null ? String(archivedPlan.boilTime) : "",
            boilOff: archivedPlan.boilOffRate != null ? String(archivedPlan.boilOffRate) : "",
            trub: archivedPlan.trub != null ? String(archivedPlan.trub) : "",
            absorption: archivedPlan.absorption != null ? String(archivedPlan.absorption) : "",
            grainTemp: archivedPlan.grainTemp != null ? String(archivedPlan.grainTemp) : "",
            notes: archivedPlan.notes || ""
          } : clone(defaultRecipeSections().mashGuidelines),
          defaults: currentRecipeDefaults()
        }
      };
      data.recipes.unshift(recipe);
      data.selectedRecipeId = recipe.id;
      persistData();
      renderRecipes();
      setActiveTab('recipes');
    }

    function archiveCurrentBatch(){
      const b = data.currentBatch;
      if (!b.name){
        alert("Give the current batch a name first.");
        return;
      }
      const ready = getPackagingReadiness();
      if (ready.score < ready.max && !confirm(`This batch looks only ${ready.score}/${ready.max} ready to archive. Archive anyway?`)) return;
      data.archive.unshift({
        id: makeId("arch"), date: todayStr(), name: b.name, style: b.style, type: b.type, volume: b.volume,
        og: b.og, fg: b.fg, abv: b.abv || calcABV(b.og, b.fg), notes: b.notes || "", ingredients: b.ingredients || "",
        process: b.process || "", packagingNotes: data.packaging.notes || "", tastingNotes: data.packaging.tastingNotes || "",
        rating: data.packaging.rating || "", wouldBrewAgain: Boolean(data.packaging.wouldBrewAgain), tags: data.packaging.tags || "",
        biabPlan: b.biab ? clone(b.biab) : null, sourceRecipeId: b.sourceRecipeId || "",
        waterChemistry: clone(data.waterChemistry)
      });
      persistData();
      renderArchive();
      setActiveTab("archive");
    }

    async function copySummary(){
      try{
        await navigator.clipboard.writeText($("summaryBox").innerText);
        [$("copyNotesBtn"), $("copySummaryTopBtn")].forEach((btn) => { if (btn) btn.textContent = "Copied"; });
        setTimeout(() => {
          if ($("copyNotesBtn")) $("copyNotesBtn").textContent = "Copy notes";
          if ($("copySummaryTopBtn")) $("copySummaryTopBtn").textContent = "Copy Summary";
        }, 1200);
      } catch(error){
        alert("Could not copy summary.");
      }
    }

    function bindTabs(){
      document.addEventListener("click", (event) => {
        const tabBtn = event.target.closest("[data-tab]");
        if (tabBtn) setActiveTab(tabBtn.dataset.tab);
        const openBtn = event.target.closest("[data-open-tab]");
        if (openBtn) setActiveTab(openBtn.dataset.openTab);
      });
      setActiveTab(data.activeTab || "brewday");
    }

    function bindBatchInputs(){
      ["batchNotes"].forEach((id) => {
        $(id).addEventListener("input", () => {
          data.currentBatch.notes = $("batchNotes").value;
          persistData();
          renderBatchInputs();
          renderSummary();
          renderMiniBatchSummary();
        });
      });
      if ($("copyLoadedBatchBtn")) $("copyLoadedBatchBtn").onclick = async () => {
        const b = data.currentBatch;
        const text = `${b.name || "Untitled batch"}
${b.type || "Beer"} · ${b.style || "—"}
Volume: ${b.volume || "—"} gal
OG/FG: ${b.og || "—"} / ${b.fg || "—"}
ABV: ${computedAbvValue(b.og,b.fg) || b.abv || "—"}%

Ingredients
${b.ingredients || "—"}

Process
${b.process || "—"}

Running notes
${b.notes || "—"}`;
        await navigator.clipboard.writeText(text);
        alert("Batch card copied.");
      };
    }

    function bindChecklist(){
      $("checklist").addEventListener("change", (event) => {
        if (!event.target.matches("[data-check-index]")) return;
        const idx = Number(event.target.dataset.checkIndex);
        data.checklists.beer[idx].done = event.target.checked;
        persistData();
        renderChecklist();
        renderSummary();
      });

      $("checkAllOff").onclick = () => {
        data.activeChecklistType = "beer";
        data.checklists.beer = data.checklists.beer.map((item) => ({ ...item, done: false }));
        persistData();
        renderChecklist();
        renderSummary();
      };
      if ($("loadBeerChecklist")) $("loadBeerChecklist").onclick = () => {
        data.activeChecklistType = "beer";
        persistData();
        renderChecklist();
        renderSummary();
      };
    }

    function bindGravity(){
      $("gravityDate").value = todayStr();

      $("addGravityBtn").onclick = () => {
        const gravity = parseMaybeDecimal($("gravityValue").value);
        if (!$("gravityDate").value || !gravity) return;
        data.gravityLog.unshift({
          id: makeId("grav"),
          date: $("gravityDate").value,
          gravity,
          stage: $("gravityStage").value,
          note: $("gravityNote").value.trim(),
          temp: $("gravityTemp").value.trim() || "",
          createdAt: new Date().toISOString()
        });
        $("gravityValue").value = "";
        $("gravityNote").value = "";
        $("gravityTemp").value = "";
        persistData();
        renderGravityLog();
        renderMiniBatchSummary();
      };

      $("clearGravityBtn").onclick = () => {
        if (!confirm("Clear all gravity log entries?")) return;
        data.gravityLog = [];
        persistData();
        renderGravityLog();
        renderMiniBatchSummary();
      };

      $("gravityLog").addEventListener("click", (event) => {
        const id = event.target.dataset.deleteGravity;
        if (!id) return;
        if (!confirm("Delete this gravity reading?")) return;
        data.gravityLog = data.gravityLog.filter((entry) => entry.id !== id);
        persistData();
        renderGravityLog();
        renderMiniBatchSummary();
      });

      document.querySelectorAll("[data-gravity-filter]").forEach((btn) => {
        btn.addEventListener("click", () => {
          data.ui.gravityFilter = btn.dataset.gravityFilter;
          persistData();
          renderGravityLog();
        });
      });
    }

    function bindSchedule(){
      $("addScheduleBtn").onclick = () => {
        const minutesLeft = Number($("scheduleTime").value);
        const item = $("scheduleItem").value.trim();
        const note = $("scheduleNote").value.trim();
        if (!item || Number.isNaN(minutesLeft) || minutesLeft < 0) return;
        data.schedule.push({
          id: makeId("sched"),
          minutesLeft,
          item,
          note
        });
        $("scheduleTime").value = "";
        $("scheduleItem").value = "";
        $("scheduleNote").value = "";
        persistData();
        renderSchedule();
        renderBoilSnapshot();
        renderStickyTimerDock();
      };

      $("loadDemoScheduleBtn").onclick = () => {
        data.schedule = [
          { id: makeId("sched"), minutesLeft: 60, item: "Bittering addition", note: "Get boil settled" },
          { id: makeId("sched"), minutesLeft: 15, item: "Lactose", note: "Stir well and avoid clumps" },
          { id: makeId("sched"), minutesLeft: 10, item: "Whirlfloc / nutrient", note: "Late kettle support" },
          { id: makeId("sched"), minutesLeft: 5, item: "Vanilla prep / adjunct check", note: "Get post-boil additions organized" }
        ];
        persistData();
        renderSchedule();
        renderBoilSnapshot();
        renderStickyTimerDock();
      };

      $("clearScheduleBtn").onclick = () => {
        if (!confirm("Clear all schedule items?")) return;
        data.schedule = [];
        persistData();
        renderSchedule();
        renderBoilSnapshot();
        renderStickyTimerDock();
      };

      $("scheduleList").addEventListener("click", (event) => {
        const id = event.target.dataset.deleteSchedule;
        if (!id) return;
        data.schedule = data.schedule.filter((entry) => entry.id !== id);
        persistData();
        renderSchedule();
        renderBoilSnapshot();
        renderStickyTimerDock();
      });

      $("scheduleSyncToggle").addEventListener("change", () => {
        data.ui.scheduleSync = $("scheduleSyncToggle").checked;
        persistData();
        renderSchedule();
        renderBoilSnapshot();
        renderStickyTimerDock();
      });

      $("useCurrentBoilBtn").onclick = () => {
        $("scheduleTime").value = getCurrentBoilMinutesLeft();
        $("scheduleItem").focus();
      };
    }

    function saveTemplateFromFields(source="form"){
      const formAbv = syncRecipeAbvField();
      const batchAbv = syncBatchAbvField();
      const payload = source === "current" ? {
        name: $("batchName").value.trim(),
        style: $("batchStyle").value.trim(),
        type: $("batchType").value,
        volume: $("batchVolume").value,
        og: normalizeDecimalInput($("batchOG").value),
        fg: normalizeDecimalInput($("batchFG").value),
        abv: batchAbv === "" ? "" : batchAbv,
        notes: $("batchNotes").value.trim(),
        ingredients: $("recipeIngredients").value.trim(),
        process: $("recipeProcess").value.trim(),
        tags: (data.packaging.tags || "").split(",").map((s) => s.trim()).filter(Boolean),
        sections: { ...defaultRecipeSections(), defaults: currentRecipeDefaults() }
      } : {
        name: $("templateName").value.trim(),
        style: $("templateStyle").value.trim(),
        type: $("templateType").value,
        volume: $("templateVolume").value,
        og: normalizeDecimalInput($("templateOG").value),
        fg: normalizeDecimalInput($("templateFG").value),
        abv: formAbv === "" ? "" : formAbv,
        notes: $("templateProcess").value.trim(),
        sections: normalizeRecipeSections({ ...getRecipeEditorSections(), defaults: window.recipeDraftDefaults || defaultRecipeSections().defaults }),
        ingredients: buildIngredientsTextFromSections(getRecipeEditorSections()),
        process: $("templateProcess").value.trim(),
        tags: $("templateTags").value.split(",").map((s) => s.trim()).filter(Boolean)
      };
      if (!payload.name) {
        alert(source === "current" ? "Give the current batch a name first." : "Give the recipe a name first.");
        return;
      }

      if (source === "form" && data.ui.editingRecipeId){
        data.recipes = data.recipes.map((recipe) => recipe.id === data.ui.editingRecipeId ? { ...recipe, quick: payload.notes, ...payload } : recipe);
        data.selectedRecipeId = data.ui.editingRecipeId;
        clearRecipeEditor();
      } else {
        const recipe = { id: makeId("recipe"), quick: payload.notes, ...payload };
        data.recipes.unshift(recipe);
        data.selectedRecipeId = recipe.id;
        if (source !== "current") clearRecipeEditor();
      }
      persistData();
      renderRecipes();
    }

    function bindRecipes(){
      window.recipeDraftDefaults = window.recipeDraftDefaults || clone(defaultRecipeSections().defaults);
      $("recipeList").addEventListener("click", (event) => {
        const item = event.target.closest("[data-recipe-id]");
        if (!item) return;
        data.selectedRecipeId = item.dataset.recipeId;
        persistData();
        renderRecipes();
      });

      if ($("saveTemplateBtn")) $("saveTemplateBtn").onclick = () => saveTemplateFromFields("form");
      if ($("saveCurrentAsTemplateBtn")) $("saveCurrentAsTemplateBtn").onclick = () => saveTemplateFromFields("current");
      if ($("duplicateRecipeBtn")) $("duplicateRecipeBtn").onclick = () => {
        const selected = data.recipes.find((recipe) => recipe.id === data.selectedRecipeId);
        if (!selected) return alert("Select a recipe first.");
        const cloneRecipe = { ...selected, id: makeId("recipe"), name: `${selected.name || "Recipe"} copy` };
        data.recipes.unshift(cloneRecipe);
        data.selectedRecipeId = cloneRecipe.id;
        persistData();
        renderRecipes();
        populateRecipeEditor(cloneRecipe);
      };
      if ($("captureScheduleDefaultsBtn")) $("captureScheduleDefaultsBtn").onclick = () => { window.recipeDraftDefaults = { ...window.recipeDraftDefaults, schedule: clone(data.schedule || []) }; updateRecipeDefaultsUi(window.recipeDraftDefaults); };
      if ($("clearScheduleDefaultsBtn")) $("clearScheduleDefaultsBtn").onclick = () => { window.recipeDraftDefaults = { ...window.recipeDraftDefaults, schedule: [] }; updateRecipeDefaultsUi(window.recipeDraftDefaults); };
      if ($("captureTimerDefaultsBtn")) $("captureTimerDefaultsBtn").onclick = () => { window.recipeDraftDefaults = { ...window.recipeDraftDefaults, timers: Object.fromEntries(TIMER_KEYS.map((key) => [key, { initial: data.timers[key].initial }])) }; updateRecipeDefaultsUi(window.recipeDraftDefaults); };
      if ($("resetTimerDefaultsBtn")) $("resetTimerDefaultsBtn").onclick = () => { window.recipeDraftDefaults = { ...window.recipeDraftDefaults, timers: clone(defaultRecipeSections().defaults.timers) }; updateRecipeDefaultsUi(window.recipeDraftDefaults); };
      if ($("capturePackagingDefaultsBtn")) $("capturePackagingDefaultsBtn").onclick = () => { window.recipeDraftDefaults = { ...window.recipeDraftDefaults, packaging: clone(currentRecipeDefaults().packaging) }; updateRecipeDefaultsUi(window.recipeDraftDefaults); };
      if ($("clearPackagingDefaultsBtn")) $("clearPackagingDefaultsBtn").onclick = () => { window.recipeDraftDefaults = { ...window.recipeDraftDefaults, packaging: null }; updateRecipeDefaultsUi(window.recipeDraftDefaults); };
      if ($("pullCurrentSetupBtn")) $("pullCurrentSetupBtn").onclick = () => { window.recipeDraftDefaults = currentRecipeDefaults(); updateRecipeDefaultsUi(window.recipeDraftDefaults); };
      if ($("copyRecipeSummaryBtn")) $("copyRecipeSummaryBtn").onclick = async () => {
        const selected = data.recipes.find((recipe) => recipe.id === data.selectedRecipeId);
        if (!selected) return alert("Select a recipe first.");
        const summary = `${selected.name || "Untitled"}
${selected.type || "Beer"} · ${selected.style || "—"}
Volume: ${selected.volume || "—"} gal
OG/FG: ${selected.og || "—"} / ${selected.fg || "—"}
ABV: ${selected.abv || computedAbvValue(selected.og, selected.fg) || "—"}%

Ingredients
${buildIngredientsTextFromSections(selected.sections) || selected.ingredients || "—"}

Process
${selected.process || selected.notes || "—"}`;
        await navigator.clipboard.writeText(summary);
        alert("Recipe summary copied.");
      };

      [["addFermentableBtn","fermentables"],["addHopBtn","hops"],["addYeastBtn","yeast"],["addOtherBtn","otherIngredients"]].forEach(([id,section]) => {
        if ($(id)) $(id).onclick = () => addRecipeSectionRow(section);
      });

      ["fermentablesRows","hopsRows","yeastRows","otherIngredientRows"].forEach((id) => {
        const container = $(id);
        if (!container) return;
        container.addEventListener("click", (event) => {
          const btn = event.target.closest("[data-remove-recipe-row]");
          if (!btn) return;
          const section = btn.dataset.removeRecipeRow;
          const sections = getRecipeEditorSections();
          sections[section] = (sections[section] || []).filter((_, index) => String(index) !== String(btn.dataset.index));
          if (!sections[section].length) sections[section] = clone(defaultRecipeSections()[section]);
          setRecipeEditorSections(sections);
        });
        container.addEventListener("input", updateGrainBillDisplay);
        container.addEventListener("change", updateGrainBillDisplay);
      });

      ["templateOG","templateFG"].forEach((id) => {
        if ($(id)) $(id).addEventListener("input", () => { syncRecipeAbvField(); updateRecipeEstimates(); });
      });
      if ($("templateVolume")) $("templateVolume").addEventListener("input", () => { updateRecipeEstimates(); renderRecipeBiabPlanner(); });
      if ($("recipeSearch")) $("recipeSearch").addEventListener("input", () => {
        data.ui.recipeQuery = $("recipeSearch").value;
        persistData();
        renderRecipes();
      });
      if ($("recipeTypeFilter")) $("recipeTypeFilter").addEventListener("change", () => {
        data.ui.recipeTypeFilter = $("recipeTypeFilter").value;
        persistData();
        renderRecipes();
      });
      if ($("recipeSort")) $("recipeSort").addEventListener("change", () => {
        data.ui.recipeSort = $("recipeSort").value;
        persistData();
        renderRecipes();
      });
      if ($("cancelRecipeEditBtn")) $("cancelRecipeEditBtn").onclick = () => {
        clearRecipeEditor();
        persistData();
      };

      ["copyAiPromptBtn","copyAiPromptBtnLibrary"].forEach((id) => {
        if ($(id)) $(id).onclick = copyAiPrompt;
      });
      [["openClaudeBtn","https://claude.ai"],["openClaudeBtnLibrary","https://claude.ai"],["openChatGPTBtn","https://chatgpt.com"],["openChatGPTBtnLibrary","https://chatgpt.com"]].forEach(([id,url]) => {
        if ($(id)) $(id).onclick = () => window.open(url, "_blank", "noopener,noreferrer");
      });
    }

    function bindPackaging(){
      $("packagingChecklist").addEventListener("change", (event) => {
        if (!event.target.matches("[data-pack-index]")) return;
        const idx = Number(event.target.dataset.packIndex);
        data.packaging.checklists[data.packaging.type][idx].done = event.target.checked;
        persistData();
        renderPackagingChecklist();
      });

      $("loadBottleChecklist").onclick = () => {
        data.packaging.type = "bottling";
        persistData();
        renderPackagingChecklist();
      };

      $("loadKegChecklist").onclick = () => {
        data.packaging.type = "kegging";
        persistData();
        renderPackagingChecklist();
      };

      $("clearPackagingChecks").onclick = () => {
        data.packaging.checklists[data.packaging.type] = data.packaging.checklists[data.packaging.type].map((item) => ({ ...item, done: false }));
        persistData();
        renderPackagingChecklist();
      };

      [["packagingNotes","notes"],["tastingNotes","tastingNotes"],["batchRating","rating"],["batchTags","tags"]].forEach(([id, key]) => {
        $(id).addEventListener("input", () => {
          data.packaging[key] = $(id).value;
          persistData();
          renderPackagingChecklist();
        });
      });

      $("wouldBrewAgain").addEventListener("change", () => {
        data.packaging.wouldBrewAgain = $("wouldBrewAgain").checked;
        persistData();
        renderPackagingChecklist();
      });

      $("copyPackagingBtn").onclick = async () => {
        const payload = [
          data.packaging.notes ? `Packaging: ${data.packaging.notes}` : "",
          data.packaging.tastingNotes ? `Tasting: ${data.packaging.tastingNotes}` : "",
          data.packaging.rating ? `Rating: ${data.packaging.rating}/5` : "",
          data.packaging.tags ? `Tags: ${data.packaging.tags}` : "",
          data.packaging.wouldBrewAgain ? "Would brew again: yes" : ""
        ].filter(Boolean).join("\n");
        try{
          await navigator.clipboard.writeText(payload);
          $("copyPackagingBtn").textContent = "Copied";
          setTimeout(() => { $("copyPackagingBtn").textContent = "Copy packaging notes"; }, 1200);
        } catch(error){
          alert("Could not copy packaging notes.");
        }
      };

      ["bottleBatchGallons","bottleSizeOz","bottleLossPct","kegTemp","kegVolumes","kegSizeGallons"].forEach((id) => {
        if ($(id)) $(id).addEventListener("input", renderPackagingHelpers);
      });

      $("archiveBatchBtn").onclick = archiveCurrentBatch;
      if ($("jumpToArchiveBtn")) $("jumpToArchiveBtn").onclick = () => setActiveTab("archive");
    }

    function bindArchive(){
      $("clearArchiveBtn").onclick = () => {
        if (!confirm("Clear the whole archive?")) return;
        data.archive = [];
        persistData();
        renderArchive();
      };
      $("archiveSearch").addEventListener("input", () => {
        data.ui.archiveQuery = $("archiveSearch").value;
        persistData();
        renderArchive();
      });
      document.querySelectorAll("[data-archive-filter]").forEach((btn) => btn.addEventListener('click', () => {
        data.ui.archiveFilter = btn.dataset.archiveFilter;
        persistData();
        renderArchive();
      }));
      $("archiveGrid").addEventListener("click", (event) => {
        const deleteId = event.target.dataset.deleteArchive;
        const loadId = event.target.dataset.loadArchive;
        const rebrewId = event.target.dataset.rebrewArchive;
        if (deleteId){
          data.archive = data.archive.filter((item) => item.id !== deleteId);
          persistData();
          renderArchive();
          return;
        }
        if (rebrewId){
          const item = data.archive.find((entry) => entry.id === rebrewId);
          if (!item) return;
          createRecipeFromArchive(item);
          return;
        }
        if (loadId){
          const item = data.archive.find((entry) => entry.id === loadId);
          if (!item) return;
          data.currentBatch = buildCurrentBatchFromArchiveItem(item);
          data.packaging.notes = item.packagingNotes || "";
          data.packaging.tastingNotes = item.tastingNotes || "";
          data.packaging.rating = item.rating || "";
          data.packaging.wouldBrewAgain = Boolean(item.wouldBrewAgain);
          data.packaging.tags = item.tags || "";
          persistData();
          renderBatchInputs();
          renderPackagingChecklist();
          renderSummary();
          renderMiniBatchSummary();
          setActiveTab("brewday");
        }
      });
    }

    /* =========================================================
   DOM binding and app boot
   ========================================================= */

function bindTimers(){
      document.querySelectorAll("[data-timer]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.dataset.timer;
          const action = btn.dataset.action;
          if (action === "start") startTimer(key);
          if (action === "pause") pauseTimer(key);
          if (action === "reset") resetTimer(key);
          renderTimers();
          renderSchedule();
          renderBoilSnapshot();
          renderStickyTimerDock();
        });
      });

      document.querySelectorAll("[data-timer-adjust]").forEach((btn) => {
        btn.addEventListener("click", () => {
          adjustTimer(btn.dataset.timerAdjust, Number(btn.dataset.seconds));
        });
      });

      document.querySelectorAll("[data-timer-apply]").forEach((btn) => {
        btn.addEventListener("click", () => applyTimerDuration(btn.dataset.timerApply));
      });

      TIMER_KEYS.forEach((key) => {
        const input = $(`${key}Duration`);
        if (!input) return;
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter"){
            event.preventDefault();
            applyTimerDuration(key);
            input.blur();
          }
        });
        input.addEventListener("change", () => applyTimerDuration(key));
        input.addEventListener("blur", () => applyTimerDuration(key));
      });
    }

    function bindCalcs(){
      ["calcOg","calcFg","primeVol","primeTemp","primeCo2"].forEach((id) => {
        if ($(id)) $(id).addEventListener("input", renderCalcs);
      });
      ["starterOG","starterVol","starterType","starterPacks"].forEach((id) => {
        if ($(id)) $(id).addEventListener("input", renderCalcs);
        if ($(id)) $(id).addEventListener("change", renderCalcs);
      });
      ["templateVolume","templateMashTemp","templateMashTime","templateBiabBoilTime","templateBiabBoilOff","templateBiabTrub","templateBiabAbsorption","templateBiabGrainTemp"].forEach((id) => {
        if ($(id)) $(id).addEventListener("input", renderRecipeBiabPlanner);
      });
      renderCalcs();
      renderRecipeBiabPlanner();
    }


    function bindDashboardOptions(){
      data.ui.compactMode = true;
      document.querySelectorAll("[data-dash-widget]").forEach((input) => {
        input.addEventListener("change", () => {
          if (!data.ui.dashboardWidgets) data.ui.dashboardWidgets = {};
          data.ui.dashboardWidgets[input.dataset.dashWidget] = input.checked;
          persistData();
          renderDashboard();
        });
      });
    }

    function bindUtilityButtons(){
      if ($("resetAllBtn")) $("resetAllBtn").onclick = () => {
        if (!confirm("Reset all brew-day data and return to a clean empty bench?")) return;
        data = normalizeData(clone(defaultData));
        persistData();
        initRender();
      };
      $("copyNotesBtn").onclick = copySummary;
      if ($("copySummaryTopBtn")) $("copySummaryTopBtn").onclick = copySummary;

      /* Export / Import (Fix 4) */
      $("exportDataBtn").onclick = () => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `funcleson-backup-${todayStr()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };
      $("importDataBtn").onclick = () => $("importFileInput").click();
      $("importFileInput").onchange = (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const imported = JSON.parse(e.target.result);
            if (!confirm("This will replace all current data with the imported file. Continue?")) return;
            data = normalizeData(imported);
            persistData();
            initRender();
            setActiveTab(data.activeTab || "dashboard");
          } catch(err){
            alert("Could not read that file. Make sure it is a valid Funcleson JSON export.");
          }
        };
        reader.readAsText(file);
        event.target.value = "";
      };
    }

    /* ── Water Chemistry bindings ─────────────────────── */
    function bindWaterChemistry(){
      ["waterGypsum","waterCaCl2","waterEpsom","waterLactic","waterPhospho","waterMashpH","waterNotes"].forEach((id) => {
        if (!$(id)) return;
        $(id).addEventListener("input", () => {
          const map = {waterGypsum:"gypsum",waterCaCl2:"cacl2",waterEpsom:"epsom",waterLactic:"lactic",waterPhospho:"phospho",waterMashpH:"mashpH",waterNotes:"notes"};
          data.waterChemistry[map[id]] = $(id).value;
          persistData();
        });
      });
    }

    function renderWaterChemistry(){
      const wc = data.waterChemistry;
      if ($("waterGypsum")) $("waterGypsum").value = wc.gypsum || "";
      if ($("waterCaCl2")) $("waterCaCl2").value = wc.cacl2 || "";
      if ($("waterEpsom")) $("waterEpsom").value = wc.epsom || "";
      if ($("waterLactic")) $("waterLactic").value = wc.lactic || "";
      if ($("waterPhospho")) $("waterPhospho").value = wc.phospho || "";
      if ($("waterMashpH")) $("waterMashpH").value = wc.mashpH || "";
      if ($("waterNotes")) $("waterNotes").value = wc.notes || "";
    }

    /* ── Brew Elapsed Timer ─────────────────────── */
    function bindBrewElapsed(){
      $("brewElapsedBtn").onclick = () => {
        if (data.brewElapsed.running){
          data.brewElapsed.running = false;
          data.brewElapsed.startedAt = null;
        } else {
          data.brewElapsed.running = true;
          data.brewElapsed.startedAt = new Date().toISOString();
        }
        persistData();
        renderBrewElapsed();
      };
      $("brewElapsedDisplay").onclick = () => {
        if (data.brewElapsed.running && confirm("Stop the brew day clock?")){
          data.brewElapsed.running = false;
          data.brewElapsed.startedAt = null;
          persistData();
          renderBrewElapsed();
        }
      };
    }

    function renderBrewElapsed(){
      const el = $("brewElapsedDisplay");
      const btn = $("brewElapsedBtn");
      if (!data.brewElapsed.running || !data.brewElapsed.startedAt){
        el.style.display = "none";
        btn.textContent = "Brew Clock";
        return;
      }
      el.style.display = "inline-flex";
      btn.textContent = "Stop Clock";
      const elapsed = Math.floor((Date.now() - new Date(data.brewElapsed.startedAt).getTime()) / 1000);
      const hrs = Math.floor(elapsed / 3600);
      const mins = Math.floor((elapsed % 3600) / 60);
      const secs = elapsed % 60;
      el.textContent = `${hrs}h ${String(mins).padStart(2,"0")}m ${String(secs).padStart(2,"0")}s`;
    }

    /* ── Batch Comparison ─────────────────────── */
    function renderCompareSelects(){
      const opts = data.archive.map((item) => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name || "Untitled")} (${escapeHTML(item.date || "—")})</option>`).join("");
      const empty = `<option value="">Pick a batch…</option>`;
      if ($("compareA")) $("compareA").innerHTML = empty + opts;
      if ($("compareB")) $("compareB").innerHTML = empty + opts;
    }

    function renderComparison(){
      const aId = $("compareA")?.value;
      const bId = $("compareB")?.value;
      if (!aId || !bId || aId === bId){
        $("compareResult").innerHTML = aId && bId && aId === bId ? "Pick two <em>different</em> batches to compare." : "Select two batches above to compare them.";
        return;
      }
      const a = data.archive.find((item) => item.id === aId);
      const b = data.archive.find((item) => item.id === bId);
      if (!a || !b){ $("compareResult").textContent = "Could not find one of the selected batches."; return; }

      const rows = [
        ["", a.name || "Untitled", b.name || "Untitled"],
        ["Style", a.style || "—", b.style || "—"],
        ["Date", a.date || "—", b.date || "—"],
        ["Volume", a.volume ? `${a.volume} gal` : "—", b.volume ? `${b.volume} gal` : "—"],
        ["OG", a.og ? Number(a.og).toFixed(3) : "—", b.og ? Number(b.og).toFixed(3) : "—"],
        ["FG", a.fg ? Number(a.fg).toFixed(3) : "—", b.fg ? Number(b.fg).toFixed(3) : "—"],
        ["ABV", a.abv ? `${Number(a.abv).toFixed(2)}%` : "—", b.abv ? `${Number(b.abv).toFixed(2)}%` : "—"],
        ["Rating", a.rating ? `${a.rating}/5` : "—", b.rating ? `${b.rating}/5` : "—"],
        ["Brew again?", a.wouldBrewAgain ? "Yes" : "No", b.wouldBrewAgain ? "Yes" : "No"],
        ["Tags", a.tags || "—", b.tags || "—"],
      ];

      const diffStyle = (va, vb) => va !== vb ? 'color:var(--orange)' : '';
      $("compareResult").innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:.88rem">
          ${rows.map(([label, va, vb], i) => `
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)">
              <td style="padding:6px 8px;color:var(--text-dim);font-weight:700;white-space:nowrap;width:80px">${escapeHTML(label)}</td>
              <td style="padding:6px 8px;${i === 0 ? 'font-weight:800;color:var(--cream)' : diffStyle(va,vb)}">${escapeHTML(va)}</td>
              <td style="padding:6px 8px;${i === 0 ? 'font-weight:800;color:var(--cream)' : diffStyle(va,vb)}">${escapeHTML(vb)}</td>
            </tr>
          `).join("")}
        </table>
        ${(a.notes || b.notes) ? `<div style="margin-top:12px"><strong style="color:var(--cream)">Notes comparison</strong><div class="form-grid" style="margin-top:8px"><div class="notes-box"><strong style="font-size:.78rem;color:var(--text-dim)">${escapeHTML(a.name)}</strong><br>${escapeHTML(a.notes || "No notes")}</div><div class="notes-box"><strong style="font-size:.78rem;color:var(--text-dim)">${escapeHTML(b.name)}</strong><br>${escapeHTML(b.notes || "No notes")}</div></div></div>` : ""}
        ${(a.tastingNotes || b.tastingNotes) ? `<div style="margin-top:10px"><strong style="color:var(--cream)">Tasting notes</strong><div class="form-grid" style="margin-top:8px"><div class="notes-box">${escapeHTML(a.tastingNotes || "None")}</div><div class="notes-box">${escapeHTML(b.tastingNotes || "None")}</div></div></div>` : ""}
      `;
    }

    function bindComparison(){
      if ($("compareA")) $("compareA").addEventListener("change", renderComparison);
      if ($("compareB")) $("compareB").addEventListener("change", renderComparison);
    }

    let _lastDueNowIds = new Set();
    function tick(){
      finishRunningTimers();
      renderTimers();
      renderSchedule();
      renderBoilSnapshot();
      renderStickyTimerDock();
      renderBrewElapsed();
      // Fix 8: audio nudge when a schedule item first becomes "Due now"
      const currentDue = getScheduleDecorated().filter((item) => item.statusLabel === "Due now");
      const currentDueIds = new Set(currentDue.map((item) => item.id));
      const newlyDue = currentDue.filter((item) => !_lastDueNowIds.has(item.id));
      if (newlyDue.length > 0) playUrgentTone();
      _lastDueNowIds = currentDueIds;
    }

    function initRender(){
      if ($("fermentablesRows")) setRecipeEditorSections(defaultRecipeSections());
      renderDashboard();
      renderBatchInputs();
      renderWaterChemistry();
      renderChecklist();
      renderGravityLog();
      renderRecipes();
      renderPackagingChecklist();
      renderTimers();
      renderSchedule();
      renderArchive();
      renderCompareSelects();
      renderSummary();
      renderMiniBatchSummary();
      renderBoilSnapshot();
      renderStickyTimerDock();
      renderBrewElapsed();
      renderCalcs();
      renderBrewMate();
    }


    function refreshAppUi(){
      initRender();
      setActiveTab(data.activeTab || "dashboard");
      updateUserUi();
    }

    let authGateButtonsBound = false;

    function bindAuthGateButtons(){
      if (authGateButtonsBound) return;
      authGateButtonsBound = true;

      if ($("signOutBtn")){
        $("signOutBtn").addEventListener("click", async () => {
          if (!firebaseAuth) return;
          try{
            await signOut(firebaseAuth);
          } catch(error){
            console.error("Sign-out failed:", error);
            alert("Could not sign out right now.");
          }
        });
      }

      if ($("googleSignInBtn")){
        $("googleSignInBtn").addEventListener("click", async () => {
          if (!firebaseAuth){
            setAuthGate("error", "Firebase Auth is not ready yet.");
            return;
          }
          try{
            updateSyncStatus("Opening Google…", "saving");
            const provider = new GoogleAuthProvider();
            await signInWithPopup(firebaseAuth, provider);
          } catch(error){
            console.error("Google sign-in failed:", error);
            const msg = error?.code === "auth/popup-blocked"
              ? "The popup was blocked. Allow popups for your Netlify site and try again."
              : error?.code === "auth/unauthorized-domain"
              ? "That domain is not authorized in Firebase Auth. Add your Netlify domain to Authorized domains."
              : (error?.message || "Google sign-in failed.");
            setAuthGate("error", msg);
            updateSyncStatus("Sign-in failed", "error");
          }
        });
      }

      if ($("retryFirebaseBtn")){
        $("retryFirebaseBtn").addEventListener("click", () => {
          initFirebaseLayer(true);
        });
      }

      if ($("openLocalModeBtn")){
        $("openLocalModeBtn").addEventListener("click", () => {
          manualLocalMode = true;
          currentUser = null;
          updateUserUi();
          updateSyncStatus("Local mode", "error");
          bootApp();
          setAuthGate("hidden");
        });
      }
    }

    function bootApp(){
      bindAuthGateButtons();
      if (appBooted){
        refreshAppUi();
        return;
      }
      bindTabs();
      bindBatchInputs();
      bindDashboardOptions();
      bindWaterChemistry();
      bindBrewElapsed();
      bindChecklist();
      bindGravity();
      bindSchedule();
      bindRecipes();
      bindPackaging();
      bindArchive();
      bindComparison();
      bindTimers();
      bindCalcs();
      bindBrewMate();
      bindUtilityButtons();

      appBooted = true;
      refreshAppUi();
      if (!tickIntervalId) tickIntervalId = setInterval(tick, 1000);
    }

    function withTimeout(promise, ms, message = "Request timed out"){
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), ms);
      });
      return Promise.race([
        promise.finally(() => clearTimeout(timeoutId)),
        timeoutPromise
      ]);
    }

    async function hydrateFromCloud(user){
      data = normalizeData(loadData());
      data.waterChemistry = { ...(data.waterChemistry || data.waterChem || {}) };
      data.waterChem = { ...(data.waterChem || data.waterChemistry || {}) };

      if (!firebaseEnabled || !firebaseDb || manualLocalMode){
        bootApp();
        setAuthGate("hidden");
        updateSyncStatus(manualLocalMode ? "Local mode" : "Local", manualLocalMode ? "error" : "ready");
        return;
      }

      setAuthGate("loading", "Pulling your saved brew state from Firestore…");
      try{
        const ref = doc(firebaseDb, FIREBASE_COLLECTION, user.uid);
        const snap = await withTimeout(getDoc(ref), 9000, "Firestore read timed out");
        if (snap.exists()){
          const payload = snap.data()?.data || snap.data() || {};
          data = normalizeData(payload);
          updateSyncStatus("Synced", "ready");
        } else {
          updateSyncStatus("Creating cloud save…", "saving");
          await withTimeout(setDoc(ref, {
            data: clone(data),
            updatedAt: new Date().toISOString(),
            uid: user.uid,
            email: user.email || "",
            displayName: user.displayName || ""
          }, { merge: true }), 9000, "Firestore write timed out");
          updateSyncStatus("Synced", "ready");
        }
      } catch(error){
        console.error("Firestore load failed:", error);
        updateSyncStatus("Local fallback", "error");
        bootApp();
        setAuthGate("error", "Cloud sync stalled, so I opened your cached local brew data instead. You can keep using the app now and retry Firebase later.");
        return;
      }

      bootApp();
      setAuthGate("hidden");
    }

    function bindAuthStateListener(){
      if (authListenerBound || !firebaseAuth) return;
      authListenerBound = true;
      onAuthStateChanged(firebaseAuth, async (user) => {
        currentUser = user || null;
        updateUserUi();

        if (!user){
          updateSyncStatus(manualLocalMode ? "Local mode" : "Sign in needed", manualLocalMode ? "error" : "error");
          if (manualLocalMode){
            bootApp();
            setAuthGate("hidden");
          } else {
            setAuthGate("signedout");
          }
          return;
        }

        await hydrateFromCloud(user);
      });
    }

    async function initFirebaseLayer(forceRetry = false){
      if (forceRetry){
        manualLocalMode = false;
        authListenerBound = false;
      }

      bindAuthGateButtons();

      if (!isFirebaseConfigFilled()){
        updateSyncStatus("Config needed", "error");
        setAuthGate("config");
        return;
      }

      try{
        setAuthGate("loading");
        const loaded = await loadFirebaseModules();
        if (!loaded){
          firebaseEnabled = false;
          updateSyncStatus("Local", "error");
          setAuthGate("error", "Firebase could not load here. Use local-only mode now, or open the app from Netlify to test sign-in and cloud sync.");
          return;
        }
        if (!firebaseAppInstance){
          firebaseAppInstance = initializeApp(firebaseConfig);
          firebaseAuth = getAuth(firebaseAppInstance);
          firebaseDb = getFirestore(firebaseAppInstance);
          firebaseEnabled = true;
        }
        bindAuthStateListener();
      } catch(error){
        console.error("Firebase init failed:", error);
        firebaseEnabled = false;
        updateSyncStatus("Firebase error", "error");
        setAuthGate("error", error?.message || "Could not initialize Firebase.");
      }
    }

    bindAuthGateButtons();
    initFirebaseLayer();
  
