import React, { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import { doc, getDoc, setDoc, collection, addDoc, query, orderBy, limit, onSnapshot } from "firebase/firestore";
import "./styles.css";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const DEFAULT_PEOPLE = ["Madz", "Aby", "Nick", "Joy", "Tin", "Rea", "Rodel"];
const ADMIN   = "Madz"; // change this to your name — admin sees everything

const DEFAULT_CARDS: CardDef[] = [
  { id: "bdo_shopmore",   name: "BDO Shopmore",       color: "#B91C1C" },
  { id: "bdo_amex",       name: "BDO AmEx",           color: "#B45309" },
  { id: "bpi",            name: "BPI",                color: "#1D4ED8" },
  { id: "atome",          name: "Atome",              color: "#059669" },
  { id: "metro_platinum", name: "Metrobank Platinum", color: "#7C3AED" },
  { id: "metro_titanium", name: "Metrobank Titanium", color: "#475569" },
  { id: "shopee",         name: "Shopee Pay Later",   color: "#EA580C" },
  { id: "lazada",         name: "Lazada Pay Later",   color: "#2563EB" },
];

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface CardDef {
  id: string;
  name: string;
  color: string;
}

interface Transaction {
  id: string;
  name: string;
  date: string;
  installment: string;
  amounts: { [person: string]: string };
}

interface CardData {
  dueDay: string;
  totalBill: string;
  paid: boolean;
  paidBy: { [person: string]: boolean }; // ← NEW: per-person paid flags
  transactions: Transaction[];
}

interface MonthData { [cardId: string]: CardData; }
interface Cache     { [year: number]: { [month: number]: MonthData } }

interface MoveModal { txId: string; toYear: number; toMonth: number; }
interface CopyModal { fromCardId: string; toYear: number; toMonth: number; selectedTxIds: string[]; }

interface AuditEntry {
  id?: string;
  who: string;
  action: string;   // "added" | "edited" | "removed" | "moved" | "copied" | "paid" | "unpaid"
  detail: string;   // human-readable description
  card: string;
  month: string;
  ts: number;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function monthKey(y: number, m: number): string {
  return y + "-" + String(m + 1).padStart(2, "0");
}
function emptyCard(): CardData {
  return { dueDay: "", totalBill: "", paid: false, paidBy: {}, transactions: [] };
}
function emptyTx(peopleList: string[]): Omit<Transaction, "id"> {
  const amounts: { [p: string]: string } = {};
  peopleList.forEach(function (p) { amounts[p] = ""; });
  return { name: "", date: "", installment: "", amounts };
}
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function toNum(s: string): number {
  const n = parseFloat(s); return isNaN(n) ? 0 : n;
}
function fmt(n: number): string {
  if (n === 0) return "—";
  return "₱" + n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtN(n: number): string {
  if (n === 0) return "—";
  return n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function txTotal(tx: Transaction, peopleList: string[] = DEFAULT_PEOPLE): number {
  return peopleList.reduce(function (s, p) { return s + toNum(tx.amounts[p]); }, 0);
}
function cardPersonTotal(card: CardData, person: string): number {
  return (card.transactions || []).reduce(function (s, tx) {
    return s + toNum(tx.amounts[person]);
  }, 0);
}
function cardGrandTotal(card: CardData, peopleList: string[] = DEFAULT_PEOPLE): number {
  return peopleList.reduce(function (s, p) { return s + cardPersonTotal(card, p); }, 0);
}
function formatDate(d: string): string {
  if (!d) return "";
  try {
    const dt = new Date(d + "T00:00:00");
    return dt.toLocaleDateString("en-PH", { month: "short", day: "numeric" });
  } catch { return d; }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000)  return "just now";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
  return Math.floor(diff / 86400000) + "d ago";
}

// ─── FIREBASE ────────────────────────────────────────────────────────────────

async function saveMonth(y: number, m: number, monthData: MonthData): Promise<void> {
  await setDoc(doc(db, "bills_v3", monthKey(y, m)), { data: JSON.stringify(monthData) });
}
async function loadMonth(y: number, m: number): Promise<MonthData | null> {
  try {
    const snap = await getDoc(doc(db, "bills_v3", monthKey(y, m)));
    if (!snap.exists()) return null;
    const raw = snap.data();
    return raw?.data ? JSON.parse(raw.data) as MonthData : null;
  } catch { return null; }
}
async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await addDoc(collection(db, "audit"), { ...entry, ts: Date.now() });
  } catch { /* non-critical */ }
}

// ─── PIN HASHING (simple SHA-256 via WebCrypto) ──────────────────────────────

async function hashPin(name: string, pin: string): Promise<string> {
  const raw = name.toLowerCase() + ":" + pin;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

async function savePinToFirebase(name: string, pin: string): Promise<void> {
  const hash = await hashPin(name, pin);
  await setDoc(doc(db, "config", "pins"), { [name]: hash }, { merge: true });
}

async function verifyPin(name: string, pin: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, "config", "pins"));
    if (!snap.exists()) return false;
    const stored = snap.data()[name];
    if (!stored) return false;
    const hash = await hashPin(name, pin);
    return hash === stored;
  } catch { return false; }
}

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function App() {
  const today = new Date();

  // ── Identity ──
  // We store both the name AND a session token set at login time.
  // If the token is missing or mismatched, treat as logged out.
  const [currentUser, setCurrentUser] = useState<string>(() => {
    const name  = localStorage.getItem("bills_user") || "";
    const token = localStorage.getItem("bills_token") || "";
    // Token must exist and match "verified_" + name to be trusted
    if (name && token === "verified_" + name) return name;
    // Clear stale data
    localStorage.removeItem("bills_user");
    localStorage.removeItem("bills_token");
    return "";
  });
  const [nameInput, setNameInput]   = useState("");
  const [pinInput,  setPinInput]    = useState("");
  const [pinError,  setPinError]    = useState("");
  const [pinLoading, setPinLoading] = useState(false);
  const isAdmin = currentUser === ADMIN;

  // ── PIN management (admin only) ──
  const [showPinManager, setShowPinManager] = useState(false);
  const [pinTarget,  setPinTarget]  = useState("");
  const [newPin,     setNewPin]     = useState("");
  const [pinSaving,  setPinSaving]  = useState(false);

  // ── Cards (dynamic) ──
  const [cards, setCards] = useState<CardDef[]>(DEFAULT_CARDS);
  const [showAddCard, setShowAddCard] = useState(false);
  const [newCardName, setNewCardName] = useState("");
  const [newCardColor, setNewCardColor] = useState("#FA8128");

  // ── People (dynamic) ──
  const [people, setPeople] = useState<string[]>(DEFAULT_PEOPLE);
  const [showAddPerson, setShowAddPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState("");

  // ── Hidden people per card (admin only, persisted in Firebase) ──
  // Shape: { [cardId]: ["Nick", "Joy", ...] }
  const [hiddenPeople, setHiddenPeople] = useState<{ [cardId: string]: string[] }>({});
  const [showHiddenFor, setShowHiddenFor] = useState<string | null>(null); // cardId whose hidden list is revealed

  // ── Data ──
  const [cache, setCache]             = useState<Cache>({});
  const [year, setYear]               = useState(today.getFullYear());
  const [month, setMonth]             = useState(today.getMonth());
  const [activeCard, setActiveCard]   = useState(DEFAULT_CARDS[0].id);
  const [view, setView]               = useState<"detail" | "summary" | "audit">("detail");
  const [loadingMonth, setLoadingMonth] = useState(false);
  const [saveStatus, setSaveStatus]   = useState<"saving"|"saved"|"error">("saved");
  const isLoadedRef                   = useRef(false);

  // ── Audit ──
  const [auditLog, setAuditLog]       = useState<AuditEntry[]>([]);
  const [auditCard, setAuditCard]     = useState<string>("all");
  const [showHistory, setShowHistory] = useState(false);

  // ── Modals ──
  const [moveModal, setMoveModal]     = useState<MoveModal | null>(null);
  const [copyModal, setCopyModal]     = useState<CopyModal | null>(null);

  // ── Drag (transactions) ──
  const dragIdx  = useRef<number | null>(null);
  const dragOver = useRef<number | null>(null);

  // ── Drag (sidebar cards) ──
  const cardDragIdx  = useRef<number | null>(null);
  const cardDragOver = useRef<number | null>(null);

  // ── Banner ──
  const [banner, setBanner] = useState<{msg:string; type:"success"|"warn"|"error"}|null>(null);
  function showBanner(msg: string, type: "success"|"warn"|"error" = "success") {
    setBanner({ msg, type });
    setTimeout(function () { setBanner(null); }, 3000);
  }

  // ── Login with PIN ──────────────────────────────────────────────────────

  async function submitLogin() {
    const name = nameInput.trim();
    const pin  = pinInput.trim();
    if (!name) { setPinError("Please select your name."); return; }
    if (pin.length !== 4) { setPinError("PIN must be 4 digits."); return; }
    setPinLoading(true);
    setPinError("");
    try {
      // Check if ANY pins have been set yet
      const pinsSnap = await getDoc(doc(db, "config", "pins"));
      const noPinsExist = !pinsSnap.exists() || Object.keys(pinsSnap.data() || {}).length === 0;
      // First-time setup: only Madz (admin) can get in, with any 4-digit PIN which becomes their PIN
      if (noPinsExist) {
        if (name !== ADMIN) {
          setPinError("No PINs set up yet. Ask " + ADMIN + " to set up PINs first.");
          setPinLoading(false);
          return;
        }
        // Set admin PIN automatically from whatever they typed
        await savePinToFirebase(name, pin);
        localStorage.setItem("bills_user", name);
        localStorage.setItem("bills_token", "verified_" + name);
        setCurrentUser(name);
        setPinLoading(false);
        return;
      }
      // Normal login
      const ok = await verifyPin(name, pin);
      setPinLoading(false);
      if (!ok) {
        // Check if this person has no PIN yet
        const theirPin = pinsSnap.data()?.[name];
        if (!theirPin) {
          setPinError("No PIN set for you yet. Ask " + ADMIN + " to set your PIN.");
        } else {
          setPinError("Incorrect PIN. Try again.");
        }
        setPinInput("");
        return;
      }
      localStorage.setItem("bills_user", name);
      localStorage.setItem("bills_token", "verified_" + name);
      setCurrentUser(name);
    } catch {
      setPinLoading(false);
      setPinError("Connection error. Check your internet and try again.");
    }
  }

  // ── Admin: set/reset someone's PIN ──────────────────────────────────────

  async function adminSetPin() {
    if (!pinTarget) { showBanner("Select a person", "warn"); return; }
    if (newPin.length !== 4 || !/^\d{4}$/.test(newPin)) {
      showBanner("PIN must be exactly 4 digits", "warn"); return;
    }
    setPinSaving(true);
    await savePinToFirebase(pinTarget, newPin);
    setPinSaving(false);
    setNewPin("");
    setPinTarget("");
    showBanner("PIN set for " + pinTarget, "success");
    logAudit({ who: currentUser, action: "edited", detail: "PIN updated for " + pinTarget, card: "—", month: MONTHS[month] + " " + year, ts: Date.now() });
  }

  // ── Load month ──────────────────────────────────────────────────────────

  useEffect(function () {
    isLoadedRef.current = false;
    isDirtyRef.current = false;
    if (cache[year] && cache[year][month] !== undefined) {
      isLoadedRef.current = true;
      return;
    }
    setLoadingMonth(true);
    loadMonth(year, month).then(function (md) {
      setCache(function (prev) {
        const next = { ...prev };
        if (!next[year]) next[year] = {};
        next[year][month] = md || {};
        return next;
      });
      setLoadingMonth(false);
      setTimeout(function () { isLoadedRef.current = true; }, 500);
    }).catch(function () {
      setCache(function (prev) {
        const next = { ...prev };
        if (!next[year]) next[year] = {};
        next[year][month] = {};
        return next;
      });
      setLoadingMonth(false);
      setTimeout(function () { isLoadedRef.current = true; }, 500);
    });
  }, [year, month]);

  // ── Auto-save — only fires on user changes, never on load ─────────────

  const isDirtyRef = useRef(false);

  useEffect(function () {
    if (!isDirtyRef.current) return;
    const monthData = (cache[year] && cache[year][month]) ? cache[year][month] : null;
    if (!monthData) return;
    setSaveStatus("saving");
    saveMonth(year, month, monthData)
      .then(function () { setSaveStatus("saved"); })
      .catch(function () { setSaveStatus("error"); });
  }, [cache]);

  // ── Audit log listener ──────────────────────────────────────────────────

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(function () {
    const q = query(collection(db, "audit"), orderBy("ts", "desc"), limit(100));
    const unsub = onSnapshot(q, function (snap) {
      const entries: AuditEntry[] = [];
      snap.forEach(function (d) {
        entries.push({ id: d.id, ...d.data() } as AuditEntry);
      });
      setAuditLog(entries);
    });
    return unsub;
  }, []);

  // ── Load cards, people, hiddenPeople from Firebase on mount ────────────

  useEffect(function () {
    // Load cards
    getDoc(doc(db, "config", "cards")).then(function (snap) {
      if (snap.exists() && Array.isArray(snap.data()?.list) && snap.data().list.length > 0) {
        setCards(snap.data().list as CardDef[]);
      }
    }).catch(function () {});

    // Load people
    getDoc(doc(db, "config", "people")).then(function (snap) {
      if (snap.exists() && Array.isArray(snap.data()?.list) && snap.data().list.length > 0) {
        setPeople(snap.data().list as string[]);
      }
    }).catch(function () {});

    // Load hiddenPeople
    getDoc(doc(db, "config", "hiddenPeople")).then(function (snap) {
      if (snap.exists() && snap.data()?.map) {
        setHiddenPeople(snap.data().map as { [cardId: string]: string[] });
      }
    }).catch(function () {});
  }, []);

  function saveHiddenPeople(next: { [cardId: string]: string[] }) {
    setHiddenPeople(next);
    setDoc(doc(db, "config", "hiddenPeople"), { map: next }).catch(function () {});
  }

  function hidePersonFromCard(cardId: string, person: string) {
    const current = hiddenPeople[cardId] || [];
    if (current.includes(person)) return;
    saveHiddenPeople({ ...hiddenPeople, [cardId]: [...current, person] });
  }

  function showPersonOnCard(cardId: string, person: string) {
    const current = hiddenPeople[cardId] || [];
    saveHiddenPeople({ ...hiddenPeople, [cardId]: current.filter(function (p) { return p !== person; }) });
  }

  function visiblePeople(cardId: string): string[] {
    const hidden = hiddenPeople[cardId] || [];
    return people.filter(function (p) { return !hidden.includes(p); });
  }

  function hiddenPeopleForCard(cardId: string): string[] {
    return (hiddenPeople[cardId] || []).filter(function (p) { return people.includes(p); });
  }

  // ── Data helpers ────────────────────────────────────────────────────────

  function getCard(y: number, m: number, cid: string): CardData {
    const raw = (cache[y] && cache[y][m] && cache[y][m][cid]) ? cache[y][m][cid] : emptyCard();
    // Ensure paidBy always exists (backwards compat for old data)
    return { ...raw, paidBy: raw.paidBy || {} };
  }

  function mutateCard(y: number, m: number, cid: string, fn: (c: CardData) => CardData) {
    isDirtyRef.current = true;
    setCache(function (prev) {
      const next: Cache = JSON.parse(JSON.stringify(prev));
      if (!next[y])    next[y] = {};
      if (!next[y][m]) next[y][m] = {};
      const existing = next[y][m][cid] || emptyCard();
      // Ensure paidBy exists on existing data
      if (!existing.paidBy) existing.paidBy = {};
      next[y][m][cid] = fn(existing);
      return next;
    });
  }

  // ── Card management ──────────────────────────────────────────────────────

  function saveCards(newCards: CardDef[]) {
    setCards(newCards);
    setDoc(doc(db, "config", "cards"), { list: newCards }).catch(function () {});
  }

  function addCard() {
    const name = newCardName.trim();
    if (!name) { showBanner("Enter a card name", "warn"); return; }
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, "_") + "_" + Date.now().toString(36);
    const newCard: CardDef = { id, name, color: newCardColor };
    saveCards([...cards, newCard]);
    setNewCardName("");
    setNewCardColor("#FA8128");
    setShowAddCard(false);
    showBanner(name + " added!", "success");
    logAudit({ who: currentUser, action: "added", detail: "Added new card: " + name, card: name, month: MONTHS[month] + " " + year, ts: Date.now() });
  }

  function removeCard(cardId: string) {
    const card = cards.find(function (c) { return c.id === cardId; });
    if (!card) return;
    if (!window.confirm("Remove " + card.name + "? Existing transaction data is kept in Firebase.")) return;
    saveCards(cards.filter(function (c) { return c.id !== cardId; }));
    showBanner(card.name + " removed from list", "warn");
  }

  // ── People management ─────────────────────────────────────────────────────

  function savePeople(newPeople: string[]) {
    setPeople(newPeople);
    setDoc(doc(db, "config", "people"), { list: newPeople }).catch(function () {});
  }

  function addPerson() {
    const name = newPersonName.trim();
    if (!name) { showBanner("Enter a name", "warn"); return; }
    if (people.find(function (p) { return p.toLowerCase() === name.toLowerCase(); })) {
      showBanner(name + " already exists", "warn"); return;
    }
    savePeople([...people, name]);
    setNewPersonName("");
    setShowAddPerson(false);
    showBanner(name + " added!", "success");
    logAudit({ who: currentUser, action: "added", detail: "Added new person: " + name, card: "—", month: MONTHS[month] + " " + year, ts: Date.now() });
  }

  function removePerson(name: string) {
    if (DEFAULT_PEOPLE.includes(name)) { showBanner("Cannot remove original members", "warn"); return; }
    if (!window.confirm("Remove " + name + " from the list?")) return;
    savePeople(people.filter(function (p) { return p !== name; }));
    showBanner(name + " removed", "warn");
  }

  function updateCardField(cid: string, field: "dueDay"|"totalBill", val: string) {
    mutateCard(year, month, cid, function (c) { return { ...c, [field]: val }; });
  }

  // ── Toggle card-level paid ───────────────────────────────────────────────

  function togglePaid(cid: string) {
    const card = getCard(year, month, cid);
    const newPaid = !card.paid;
    mutateCard(year, month, cid, function (c) { return { ...c, paid: newPaid }; });
    const cardName = cards.find(function (c) { return c.id === cid; })?.name || cid;
    logAudit({
      who: currentUser, action: newPaid ? "paid" : "unpaid",
      detail: cardName + " marked as " + (newPaid ? "Paid" : "Unpaid"),
      card: cardName, month: MONTHS[month] + " " + year, ts: Date.now(),
    });
  }

  // ── Toggle per-person paid ───────────────────────────────────────────────

  function togglePersonPaid(cid: string, person: string) {
    // Non-admin can only toggle themselves
    if (!isAdmin && person !== currentUser) return;
    const card = getCard(year, month, cid);
    const currentlyPaid = !!(card.paidBy && card.paidBy[person]);
    const newPaid = !currentlyPaid;
    mutateCard(year, month, cid, function (c) {
      return { ...c, paidBy: { ...(c.paidBy || {}), [person]: newPaid } };
    });
    const cardName = cards.find(function (c) { return c.id === cid; })?.name || cid;
    logAudit({
      who: currentUser, action: newPaid ? "paid" : "unpaid",
      detail: person + " marked as " + (newPaid ? "Paid" : "Unpaid") + " for " + cardName,
      card: cardName, month: MONTHS[month] + " " + year, ts: Date.now(),
    });
    showBanner(person + (newPaid ? " marked as Paid ✓" : " marked as Unpaid"), newPaid ? "success" : "warn");
  }

  function addTx(cid: string) {
    const newTx = { id: uid(), ...emptyTx(people) };
    mutateCard(year, month, cid, function (c) {
      return { ...c, transactions: [...(c.transactions || []), newTx] };
    });
    const cardName = cards.find(function (c) { return c.id === cid; })?.name || cid;
    logAudit({
      who: currentUser, action: "added",
      detail: "New transaction added to " + cardName,
      card: cardName, month: MONTHS[month] + " " + year, ts: Date.now(),
    });
  }

  function removeTx(cid: string, txId: string) {
    if (!window.confirm("Remove this transaction?")) return;
    const tx = getCard(year, month, cid).transactions.find(function (t) { return t.id === txId; });
    mutateCard(year, month, cid, function (c) {
      return { ...c, transactions: c.transactions.filter(function (t) { return t.id !== txId; }) };
    });
    const cardName = cards.find(function (c) { return c.id === cid; })?.name || cid;
    logAudit({
      who: currentUser, action: "removed",
      detail: "Removed \"" + (tx?.name || "transaction") + "\" from " + cardName,
      card: cardName, month: MONTHS[month] + " " + year, ts: Date.now(),
    });
  }

  function updateTxField(cid: string, txId: string, field: "name"|"date"|"installment", val: string) {
    mutateCard(year, month, cid, function (c) {
      return {
        ...c,
        transactions: c.transactions.map(function (t) {
          return t.id === txId ? { ...t, [field]: val } : t;
        }),
      };
    });
  }

  function updateAmount(cid: string, txId: string, person: string, val: string) {
    mutateCard(year, month, cid, function (c) {
      return {
        ...c,
        transactions: c.transactions.map(function (t) {
          if (t.id !== txId) return t;
          return { ...t, amounts: { ...t.amounts, [person]: val } };
        }),
      };
    });
  }

  // Log field edits on blur
  function logEdit(cid: string, txName: string) {
    const cardName = cards.find(function (c) { return c.id === cid; })?.name || cid;
    logAudit({
      who: currentUser, action: "edited",
      detail: "Edited \"" + (txName || "transaction") + "\" in " + cardName,
      card: cardName, month: MONTHS[month] + " " + year, ts: Date.now(),
    });
  }

  // ── Drag to reorder ─────────────────────────────────────────────────────

  function onDragStart(idx: number) { dragIdx.current = idx; }
  function onDragEnter(idx: number) { dragOver.current = idx; }
  function onDragEnd(cid: string) {
    const from = dragIdx.current;
    const to   = dragOver.current;
    if (from === null || to === null || from === to) return;
    mutateCard(year, month, cid, function (c) {
      const txs = [...c.transactions];
      const [moved] = txs.splice(from, 1);
      txs.splice(to, 0, moved);
      return { ...c, transactions: txs };
    });
    dragIdx.current  = null;
    dragOver.current = null;
  }

  // ── Reorder sidebar cards ───────────────────────────────────────────────

  function onCardDragStart(idx: number) { cardDragIdx.current = idx; }
  function onCardDragEnter(idx: number) { cardDragOver.current = idx; }
  function onCardDragEnd() {
    const from = cardDragIdx.current;
    const to   = cardDragOver.current;
    if (from === null || to === null || from === to) {
      cardDragIdx.current  = null;
      cardDragOver.current = null;
      return;
    }
    const reordered = [...cards];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    saveCards(reordered);
    cardDragIdx.current  = null;
    cardDragOver.current = null;
  }

  // ── Move transaction ────────────────────────────────────────────────────

  async function confirmMove() {
    if (!moveModal) return;
    const { txId, toYear, toMonth } = moveModal;
    const srcCard = getCard(year, month, activeCard);
    const tx = srcCard.transactions.find(function (t) { return t.id === txId; });
    if (!tx) return;

    if (!(cache[toYear] && cache[toYear][toMonth] !== undefined)) {
      const md = await loadMonth(toYear, toMonth);
      setCache(function (prev) {
        const next = { ...prev };
        if (!next[toYear]) next[toYear] = {};
        next[toYear][toMonth] = md || {};
        return next;
      });
    }

    mutateCard(year, month, activeCard, function (c) {
      return { ...c, transactions: c.transactions.filter(function (t) { return t.id !== txId; }) };
    });
    mutateCard(toYear, toMonth, activeCard, function (c) {
      return { ...c, transactions: [...(c.transactions || []), { ...tx, id: uid() }] };
    });

    const cardName = cards.find(function (c) { return c.id === activeCard; })?.name || activeCard;
    logAudit({
      who: currentUser, action: "moved",
      detail: "Moved \"" + tx.name + "\" from " + MONTHS[month] + " " + year + " → " + MONTHS[toMonth] + " " + toYear,
      card: cardName, month: MONTHS[month] + " " + year, ts: Date.now(),
    });

    setMoveModal(null);
    showBanner("Moved to " + MONTHS[toMonth] + " " + toYear, "success");
  }

  // ── Copy transactions ───────────────────────────────────────────────────

  function openCopyModal(cid: string) {
    const srcCard = getCard(year, month, cid);
    if (!srcCard.transactions?.length) { showBanner("No transactions to copy", "warn"); return; }
    setCopyModal({
      fromCardId: cid, toYear: year,
      toMonth: month === 11 ? 0 : month + 1,
      selectedTxIds: srcCard.transactions.map(function (t) { return t.id; }),
    });
  }

  function toggleCopyTx(txId: string) {
    setCopyModal(function (prev) {
      if (!prev) return prev;
      const already = prev.selectedTxIds.includes(txId);
      return {
        ...prev,
        selectedTxIds: already
          ? prev.selectedTxIds.filter(function (id) { return id !== txId; })
          : [...prev.selectedTxIds, txId],
      };
    });
  }

  async function confirmCopy() {
    if (!copyModal) return;
    const { fromCardId, toYear, toMonth, selectedTxIds } = copyModal;
    const srcCard = getCard(year, month, fromCardId);
    const txsToCopy = srcCard.transactions.filter(function (t) { return selectedTxIds.includes(t.id); });
    if (!txsToCopy.length) { showBanner("Select at least one transaction", "warn"); return; }

    if (!(cache[toYear] && cache[toYear][toMonth] !== undefined)) {
      const md = await loadMonth(toYear, toMonth);
      setCache(function (prev) {
        const next = { ...prev };
        if (!next[toYear]) next[toYear] = {};
        next[toYear][toMonth] = md || {};
        return next;
      });
    }

    mutateCard(toYear, toMonth, fromCardId, function (c) {
      const newTxs = txsToCopy.map(function (t) { return { ...t, id: uid() }; });
      return { ...c, transactions: [...(c.transactions || []), ...newTxs] };
    });

    const cardName = cards.find(function (c) { return c.id === fromCardId; })?.name || fromCardId;
    logAudit({
      who: currentUser, action: "copied",
      detail: "Copied " + txsToCopy.length + " transaction(s) to " + MONTHS[toMonth] + " " + toYear,
      card: cardName, month: MONTHS[month] + " " + year, ts: Date.now(),
    });

    setCopyModal(null);
    showBanner("Copied " + txsToCopy.length + " transaction(s) to " + MONTHS[toMonth] + " " + toYear, "success");
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  function prevMonth() {
    if (month === 0) { setMonth(11); setYear(function (y) { return y - 1; }); }
    else setMonth(function (m) { return m - 1; });
  }
  function nextMonth() {
    if (month === 11) { setMonth(0); setYear(function (y) { return y + 1; }); }
    else setMonth(function (m) { return m + 1; });
  }

  function grandPersonTotal(person: string): number {
    return cards.reduce(function (s, c) {
      return s + cardPersonTotal(getCard(year, month, c.id), person);
    }, 0);
  }

  // ── Login screen ────────────────────────────────────────────────────────

  if (!currentUser) {
    // First-time setup: no PINs exist yet, only show to admin by name match
    const isFirstSetup = !pinLoading && nameInput === ADMIN && pinInput === "" && false; // handled below

    return (
      <div className="name-screen">
        <div className="name-box">
          <div className="name-title">Bills Tracker</div>
          <div className="name-sub">Select your name and enter your PIN</div>
          {pinError && (
            <div style={{ background:"#7f1d1d", color:"#fca5a5", border:"1px solid #991b1b", borderRadius:8, padding:"10px 14px", fontSize:13, fontWeight:600 }}>
              {pinError}
            </div>
          )}
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              <label style={{ fontSize:10, color:"#C85A10", textTransform:"uppercase", letterSpacing:".08em" }}>Your Name</label>
              <select
                className="name-input"
                style={{ cursor:"pointer" }}
                value={nameInput}
                onChange={function (e) { setNameInput(e.target.value); setPinError(""); setPinInput(""); }}>
                <option value="">Select your name…</option>
                {people.map(function (p) { return <option key={p} value={p}>{p}</option>; })}
              </select>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              <label style={{ fontSize:10, color:"#C85A10", textTransform:"uppercase", letterSpacing:".08em" }}>PIN</label>
              <input
                className="name-input"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={pinInput}
                onChange={function (e) { setPinInput(e.target.value.replace(/[^0-9]/g, "")); setPinError(""); }}
                onKeyDown={function (e) { if (e.key === "Enter") submitLogin(); }}
                placeholder="4-digit PIN"
                style={{ letterSpacing:"0.4em", fontSize:20, textAlign:"center" }}
              />
            </div>
          </div>
          <button className="name-btn" onClick={submitLogin} disabled={pinLoading || !nameInput}>
            {pinLoading ? "Checking…" : "Sign In"}
          </button>
          <div className="name-hint">Forgot your PIN? Ask Madz to reset it from inside the app.</div>
        </div>
      </div>
    );
  }

  // ── Main render ─────────────────────────────────────────────────────────

  const meta = cards.find(function (c) { return c.id === activeCard; }) || DEFAULT_CARDS[0];
  const acd  = getCard(year, month, activeCard);

  const filteredAudit = auditCard === "all"
    ? auditLog
    : auditLog.filter(function (e) { return e.card === auditCard; });

  const actionColor: { [k: string]: string } = {
    added: "#4ade80", removed: "#ef4444", edited: "#fbbf24",
    moved: "#60a5fa", copied: "#a78bfa", paid: "#34d399", unpaid: "#f87171",
  };

  return (
    <div className="app">
      {banner && <div className={"banner banner-" + banner.type} style={{ position:"fixed", top:0, left:0, right:0, zIndex:9999 }}>{banner.msg}</div>}

      {/* ── MOVE MODAL ── */}
      {moveModal && (function () {
        const tx = acd.transactions.find(function (t) { return t.id === moveModal.txId; });
        return (
          <div className="modal-backdrop" onClick={function () { setMoveModal(null); }}>
            <div className="modal" onClick={function (e) { e.stopPropagation(); }}>
              <div className="modal-title">Move Transaction</div>
              <div className="modal-tx-name">{tx?.name || "Transaction"}</div>
              <div className="modal-body">
                <div className="modal-row">
                  <label className="modal-lbl">Move to Month</label>
                  <select className="modal-sel" value={moveModal.toMonth}
                    onChange={function (e) { setMoveModal(function (p) { return p ? { ...p, toMonth: +e.target.value } : p; }); }}>
                    {MONTHS.map(function (m, i) { return <option key={i} value={i}>{m}</option>; })}
                  </select>
                </div>
                <div className="modal-row">
                  <label className="modal-lbl">Year</label>
                  <div className="modal-year-nav">
                    <button className="modal-yr-btn" onClick={function () { setMoveModal(function (p) { return p ? { ...p, toYear: p.toYear - 1 } : p; }); }}>‹</button>
                    <span className="modal-yr">{moveModal.toYear}</span>
                    <button className="modal-yr-btn" onClick={function () { setMoveModal(function (p) { return p ? { ...p, toYear: p.toYear + 1 } : p; }); }}>›</button>
                  </div>
                </div>
              </div>
              <div className="modal-note">From <strong>{MONTHS[month]} {year}</strong> → <strong>{MONTHS[moveModal.toMonth]} {moveModal.toYear}</strong></div>
              <div className="modal-actions">
                <button className="modal-cancel" onClick={function () { setMoveModal(null); }}>Cancel</button>
                <button className="modal-confirm" onClick={confirmMove}>Move Transaction</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── COPY MODAL ── */}
      {copyModal && (function () {
        const srcCard  = getCard(year, month, copyModal.fromCardId);
        const cardMeta = cards.find(function (c) { return c.id === copyModal.fromCardId; }) || DEFAULT_CARDS[0];
        return (
          <div className="modal-backdrop" onClick={function () { setCopyModal(null); }}>
            <div className="modal modal-wide" onClick={function (e) { e.stopPropagation(); }}>
              <div className="modal-title">Copy Transactions</div>
              <div className="modal-tx-name" style={{ color: cardMeta.color }}>{cardMeta.name}</div>
              <div className="modal-body">
                <div className="modal-row">
                  <label className="modal-lbl">Copy to Month</label>
                  <select className="modal-sel" value={copyModal.toMonth}
                    onChange={function (e) { setCopyModal(function (p) { return p ? { ...p, toMonth: +e.target.value } : p; }); }}>
                    {MONTHS.map(function (m, i) { return <option key={i} value={i}>{m}</option>; })}
                  </select>
                </div>
                <div className="modal-row">
                  <label className="modal-lbl">Year</label>
                  <div className="modal-year-nav">
                    <button className="modal-yr-btn" onClick={function () { setCopyModal(function (p) { return p ? { ...p, toYear: p.toYear - 1 } : p; }); }}>‹</button>
                    <span className="modal-yr">{copyModal.toYear}</span>
                    <button className="modal-yr-btn" onClick={function () { setCopyModal(function (p) { return p ? { ...p, toYear: p.toYear + 1 } : p; }); }}>›</button>
                  </div>
                </div>
              </div>
              <div className="copy-tx-list">
                <div className="copy-tx-header">
                  <span>Select transactions to copy</span>
                  <div className="copy-sel-all">
                    <button className="copy-sel-btn" onClick={function () { setCopyModal(function (p) { return p ? { ...p, selectedTxIds: srcCard.transactions.map(function (t) { return t.id; }) } : p; }); }}>All</button>
                    <button className="copy-sel-btn" onClick={function () { setCopyModal(function (p) { return p ? { ...p, selectedTxIds: [] } : p; }); }}>None</button>
                  </div>
                </div>
                {srcCard.transactions.map(function (tx) {
                  const sel = copyModal.selectedTxIds.includes(tx.id);
                  return (
                    <div key={tx.id} className={sel ? "copy-tx-row selected" : "copy-tx-row"} onClick={function () { toggleCopyTx(tx.id); }}>
                      <div className={sel ? "copy-check on" : "copy-check"}>{sel ? "✓" : ""}</div>
                      <div className="copy-tx-info">
                        <span className="copy-tx-name">{tx.name || "(unnamed)"}</span>
                        {tx.installment && <span className="copy-tx-inst">{tx.installment}</span>}
                        {tx.date && <span className="copy-tx-date">{tx.date}</span>}
                      </div>
                      <div className="copy-tx-amt">{fmtN(txTotal(tx, people))}</div>
                    </div>
                  );
                })}
              </div>
              <div className="modal-note">Copying <strong>{copyModal.selectedTxIds.length}</strong> transaction(s) → <strong>{MONTHS[copyModal.toMonth]} {copyModal.toYear}</strong></div>
              <div className="modal-actions">
                <button className="modal-cancel" onClick={function () { setCopyModal(null); }}>Cancel</button>
                <button className="modal-confirm" onClick={confirmCopy} disabled={copyModal.selectedTxIds.length === 0}>
                  Copy {copyModal.selectedTxIds.length > 0 ? "(" + copyModal.selectedTxIds.length + ")" : ""}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── ADD CARD MODAL ── */}
      {showAddCard && (
        <div className="modal-backdrop" onClick={function () { setShowAddCard(false); }}>
          <div className="modal" onClick={function (e) { e.stopPropagation(); }}>
            <div className="modal-title">Add New Card</div>
            <div className="modal-body">
              <div className="modal-row">
                <label className="modal-lbl">Card Name</label>
                <input className="modal-sel" style={{ flex:1 }} value={newCardName}
                  placeholder="e.g. RCBC Credit Card"
                  onChange={function (e) { setNewCardName(e.target.value); }}
                  onKeyDown={function (e) { if (e.key === "Enter") addCard(); }}
                  autoFocus />
              </div>
              <div className="modal-row">
                <label className="modal-lbl">Color</label>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <input type="color" value={newCardColor}
                    onChange={function (e) { setNewCardColor(e.target.value); }}
                    style={{ width:40, height:32, border:"none", background:"none", cursor:"pointer" }} />
                  <span style={{ fontSize:12, color:"#A67C3A" }}>{newCardColor}</span>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                    {["#B91C1C","#B45309","#1D4ED8","#059669","#7C3AED","#475569","#EA580C","#FA8128","#DB2777","#0891B2"].map(function (c) {
                      return (
                        <div key={c} onClick={function () { setNewCardColor(c); }}
                          style={{ width:20, height:20, borderRadius:"50%", background:c, cursor:"pointer", border: newCardColor === c ? "2px solid #fff" : "2px solid transparent" }} />
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16, padding:"10px 14px", background:"rgba(250,129,40,.08)", borderRadius:8 }}>
              <div style={{ width:12, height:12, borderRadius:"50%", background:newCardColor, boxShadow:"0 0 8px " + newCardColor }} />
              <span style={{ fontSize:13, color:"#FDF3E3" }}>{newCardName || "Card Name Preview"}</span>
            </div>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={function () { setShowAddCard(false); }}>Cancel</button>
              <button className="modal-confirm" onClick={addCard}>Add Card</button>
            </div>
          </div>
        </div>
      )}

      {/* ── ADD PERSON MODAL ── */}
      {showAddPerson && (
        <div className="modal-backdrop" onClick={function () { setShowAddPerson(false); }}>
          <div className="modal" onClick={function (e) { e.stopPropagation(); }}>
            <div className="modal-title">Add New Person</div>
            <div className="modal-body">
              <div className="modal-row">
                <label className="modal-lbl">Name</label>
                <input className="modal-sel" style={{ flex:1 }} value={newPersonName}
                  placeholder="e.g. Dana, Marco..."
                  onChange={function (e) { setNewPersonName(e.target.value); }}
                  onKeyDown={function (e) { if (e.key === "Enter") addPerson(); }}
                  autoFocus />
              </div>
            </div>
            <div className="modal-note">
              This person will appear as a column in all cards across all months.
            </div>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={function () { setShowAddPerson(false); }}>Cancel</button>
              <button className="modal-confirm" onClick={addPerson}>Add Person</button>
            </div>
          </div>
        </div>
      )}

      {/* ── PIN MANAGER MODAL (admin only) ── */}
      {showPinManager && isAdmin && (
        <div className="modal-backdrop" onClick={function () { setShowPinManager(false); }}>
          <div className="modal" onClick={function (e) { e.stopPropagation(); }}>
            <div className="modal-title">Manage PINs</div>
            <div className="modal-tx-name" style={{ color:"#C85A10" }}>Set or reset a person's 4-digit PIN</div>
            <div className="modal-body">
              <div className="modal-row">
                <label className="modal-lbl">Person</label>
                <select className="modal-sel" value={pinTarget}
                  onChange={function (e) { setPinTarget(e.target.value); }}>
                  <option value="">Select…</option>
                  {people.map(function (p) { return <option key={p} value={p}>{p}</option>; })}
                </select>
              </div>
              <div className="modal-row">
                <label className="modal-lbl">New PIN</label>
                <input
                  className="modal-sel"
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="4 digits"
                  value={newPin}
                  onChange={function (e) { setNewPin(e.target.value.replace(/[^0-9]/g, "")); }}
                  onKeyDown={function (e) { if (e.key === "Enter") adminSetPin(); }}
                  style={{ flex:1, letterSpacing:"0.3em", fontSize:18 }}
                />
              </div>
            </div>
            <div className="modal-note">PINs are hashed before saving — not readable by anyone, including admin.</div>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={function () { setShowPinManager(false); setNewPin(""); setPinTarget(""); }}>Close</button>
              <button className="modal-confirm" onClick={adminSetPin} disabled={pinSaving}>
                {pinSaving ? "Saving…" : "Set PIN"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── HEADER ── */}
      <div className="header">
        <div>
          <div className="app-title">Bills Tracker</div>
          <div className="app-subtitle">
            Viewing as <span style={{ color: "#fbbf24" }}>{currentUser}</span>
            {isAdmin && <span className="admin-badge">Admin</span>}
            <button className="switch-user-btn" onClick={function () {
              localStorage.removeItem("bills_user");
            localStorage.removeItem("bills_token");
              setCurrentUser("");
              setNameInput("");
              setPinInput("");
            }}>Sign Out</button>
            {isAdmin && (
              <button className="switch-user-btn" style={{ color:"#FA8128", borderColor:"rgba(250,129,40,0.4)" }}
                onClick={function () { setShowPinManager(true); }}>Manage PINs</button>
            )}
          </div>
        </div>
        <div className="header-right">
          <div className="view-toggle">
            {isAdmin && <button className={view === "detail"  ? "toggle-btn active" : "toggle-btn"} onClick={function () { setView("detail"); }}>Detail</button>}
            <button className={view === "summary" ? "toggle-btn active" : "toggle-btn"} onClick={function () { setView("summary"); }}>
              {isAdmin ? "Summary" : "My Bills"}
            </button>
            <button className={view === "audit"   ? "toggle-btn active" : "toggle-btn"} onClick={function () { setView("audit"); }}>History</button>
          </div>
          <div className={"save-dot " + saveStatus} title={saveStatus === "saving" ? "Saving…" : saveStatus === "error" ? "Save failed" : "All changes saved"} />
        </div>
      </div>

      <div className="content">

        {/* Month / Year nav */}
        <div className="topbar">
          <div className="month-nav">
            <button className="nav-arrow" onClick={prevMonth}>‹</button>
            <div className="month-label">{MONTHS[month]} <span className="year-txt">{year}</span></div>
            <button className="nav-arrow" onClick={nextMonth}>›</button>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:16 }}>
            <div className="year-picker">
              <button className="nav-arrow" onClick={function () { setYear(function (y) { return y - 1; }); }}>‹</button>
              <div className="year-display">{year}</div>
              <button className="nav-arrow" onClick={function () { setYear(function (y) { return y + 1; }); }}>›</button>
            </div>
            {loadingMonth && <div className="month-loading">Loading…</div>}
          </div>
        </div>

        {/* ── DETAIL VIEW (admin only) ── */}
        {view === "detail" && isAdmin && (
          <div className="detail-layout">
            <div className="sidebar">
              {cards.map(function (c, idx) {
                const cd    = getCard(year, month, c.id);
                const grand = cardGrandTotal(cd, people);
                const on    = activeCard === c.id;
                // Count how many people have paid for this card
                return (
                  <button key={c.id}
                    className={on ? "side-btn on" : "side-btn"}
                    style={{ ...(on ? { borderColor: c.color + "70", background: c.color + "14" } : {}), cursor:"grab" }}
                    draggable
                    onDragStart={function (e) { e.stopPropagation(); onCardDragStart(idx); }}
                    onDragEnter={function (e) { e.stopPropagation(); onCardDragEnter(idx); }}
                    onDragEnd={function (e) { e.stopPropagation(); onCardDragEnd(); }}
                    onDragOver={function (e) { e.preventDefault(); e.stopPropagation(); }}
                    onClick={function () { setActiveCard(c.id); }}>
                    <div className="side-dot" style={{ background: c.color, boxShadow: on ? "0 0 6px " + c.color : "none" }} />
                    <div className="side-info">
                      <div className="side-name" style={{ color: on ? "#fff" : "#999" }}>{c.name}</div>
                      <div className="side-meta">
                        <span className={grand > 0 ? "side-total" : "side-empty"}>{grand > 0 ? fmt(grand) : "No entries"}</span>
                        {cd.dueDay && <span className="side-due"> · due {formatDate(cd.dueDay)}</span>}
                      </div>
                    </div>
                    {cd.paid && <span className="chk">✓</span>}
                  </button>
                );
              })}
              {isAdmin && (
                <button className="add-card-btn" onClick={function () { setShowAddCard(true); }}>
                  + Add Card
                </button>
              )}
              {isAdmin && (
                <button className="add-card-btn" style={{ borderColor:"rgba(74,222,128,.4)", color:"#4ade80" }}
                  onClick={function () { setShowAddPerson(true); }}>
                  + Add Person
                </button>
              )}
            </div>

            <div className="editor" style={{ borderColor: meta.color + "35" }}>
              <div className="ed-head">
                <div className="ed-dot" style={{ background: meta.color, boxShadow: "0 0 10px " + meta.color }} />
                <div className="ed-title">{meta.name}</div>
                {isAdmin && !DEFAULT_CARDS.find(function (c) { return c.id === meta.id; }) && (
                  <button className="remove-card-btn" onClick={function () { removeCard(meta.id); }} title="Remove this card">Remove Card</button>
                )}
                <div className="spacer" />
                {/* History toggle for this card */}
                <button className={showHistory ? "hist-btn on" : "hist-btn"} onClick={function () { setAuditCard(meta.name); setShowHistory(function (v) { return !v; }); }}>
                  {showHistory ? "Hide History" : "History"}
                </button>
                <div className="ed-inputs">
                  <div className="ed-field">
                    <label className="ed-lbl">Due Date</label>
                    <input className="ed-inp" type="date" value={acd.dueDay}
                      onChange={function (e) { updateCardField(activeCard, "dueDay", e.target.value); }} />
                  </div>
                  <div className="ed-field">
                    <label className="ed-lbl">Statement Total (₱)</label>
                    <div className="auto-total">{cardGrandTotal(acd, people) > 0 ? fmt(cardGrandTotal(acd, people)) : "—"}</div>
                  </div>
                </div>
                <div className={acd.paid ? "paid-pill on" : "paid-pill"} onClick={function () { togglePaid(activeCard); }}>
                  <div className={acd.paid ? "pill-thumb on" : "pill-thumb"} />
                  <span>{acd.paid ? "Card Paid" : "Card Unpaid"}</span>
                </div>
              </div>

              {/* Inline history panel */}
              {showHistory && (
                <div className="inline-history">
                  {auditLog.filter(function (e) { return e.card === meta.name; }).slice(0, 15).map(function (e, i) {
                    return (
                      <div key={i} className="audit-row">
                        <span className="audit-action" style={{ color: actionColor[e.action] || "#888" }}>{e.action}</span>
                        <span className="audit-who">{e.who}</span>
                        <span className="audit-detail">{e.detail}</span>
                        <span className="audit-time">{timeAgo(e.ts)}</span>
                      </div>
                    );
                  })}
                  {auditLog.filter(function (e) { return e.card === meta.name; }).length === 0 && (
                    <div className="audit-empty">No history for this card yet.</div>
                  )}
                </div>
              )}

              {/* ── PER-PERSON PAID STATUS BAR (in Detail view) ── */}
              {(acd.transactions || []).length > 0 && (
                <div style={{ display:"flex", flexWrap:"nowrap", gap:6, marginBottom:10, padding:"8px 12px", background:"rgba(250,129,40,.08)", borderRadius:8, overflowX:"auto", alignItems:"flex-start" }}>
                  {visiblePeople(activeCard).map(function (p) {
                    const t         = cardPersonTotal(acd, p);
                    const isPaid    = !!(acd.paidBy && acd.paidBy[p]);
                    const canToggle = isAdmin || p === currentUser;
                    const canHide   = isAdmin && t === 0;
                    return (
                      <div key={p} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2, minWidth:64, maxWidth:80, flexShrink:0 }}>
                        {/* Name row */}
                        <div style={{ fontSize:9, color:"#D46820", textTransform:"uppercase", letterSpacing:".05em", display:"flex", alignItems:"center", gap:2 }}>
                          {p}
                          {canHide && (
                            <span
                              style={{ cursor:"pointer", color:"#B84A08", fontSize:11, opacity:0.5, lineHeight:1 }}
                              title={"Hide " + p + " from this card"}
                              onMouseEnter={function(e){(e.target as HTMLElement).style.opacity="1";(e.target as HTMLElement).style.color="#ef4444";}}
                              onMouseLeave={function(e){(e.target as HTMLElement).style.opacity="0.5";(e.target as HTMLElement).style.color="#B84A08";}}
                              onClick={function () { hidePersonFromCard(activeCard, p); }}>×</span>
                          )}
                        </div>
                        {/* Amount */}
                        <div style={{ fontFamily:"Georgia,serif", fontSize:12, color: t > 0 ? "#FDF3E3" : "#B84A08" }}>{t > 0 ? fmt(t) : "—"}</div>
                        {/* Paid toggle — only shown if person has a balance */}
                        {t > 0 && (
                          <span
                            onClick={function () { if (canToggle) togglePersonPaid(activeCard, p); }}
                            title={canToggle ? (isPaid ? "Mark " + p + " Unpaid" : "Mark " + p + " Paid") : "Only " + p + " or admin can toggle"}
                            style={{
                              display:"inline-flex", alignItems:"center", justifyContent:"center",
                              marginTop:2, padding:"2px 5px", borderRadius:20,
                              fontSize:9, fontWeight:700, whiteSpace:"nowrap",
                              cursor: canToggle ? "pointer" : "default",
                              opacity: canToggle ? 1 : 0.4,
                              background: isPaid ? "rgba(52,211,153,.15)" : "rgba(248,113,113,.10)",
                              color:      isPaid ? "#34d399"               : "#f87171",
                              border:     isPaid ? "1px solid rgba(52,211,153,.35)" : "1px solid rgba(248,113,113,.25)",
                            }}>
                            {isPaid ? "✓ Paid" : "✗ Unpaid"}
                          </span>
                        )}
                      </div>
                    );
                  })}

                  {/* Grand total chip */}
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2, minWidth:64, flexShrink:0 }}>
                    <div style={{ fontSize:9, color:"#E07830", textTransform:"uppercase", letterSpacing:".05em" }}>TOTAL</div>
                    <div style={{ fontFamily:"Georgia,serif", fontSize:12, color:"#FA8128" }}>{fmt(cardGrandTotal(acd, people))}</div>
                  </div>

                  {/* Hidden people restore chip (admin only) */}
                  {isAdmin && hiddenPeopleForCard(activeCard).length > 0 && (
                    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2, minWidth:64, flexShrink:0, position:"relative" }}>
                      <div
                        style={{ fontSize:9, color: showHiddenFor === activeCard ? "#FA8128" : "#C85A10", textTransform:"uppercase", letterSpacing:".05em", cursor:"pointer" }}
                        onClick={function () { setShowHiddenFor(showHiddenFor === activeCard ? null : activeCard); }}>
                        {hiddenPeopleForCard(activeCard).length} hidden {showHiddenFor === activeCard ? "▴" : "▾"}
                      </div>
                      {showHiddenFor === activeCard && (
                        <div style={{ position:"absolute", top:"100%", left:0, zIndex:50, background:"#3D2410", border:"1px solid rgba(250,129,40,0.3)", borderRadius:8, padding:"6px 0", minWidth:110, boxShadow:"0 8px 24px rgba(0,0,0,.5)", marginTop:4 }}>
                          {hiddenPeopleForCard(activeCard).map(function (p) {
                            return (
                              <div key={p} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"5px 12px", fontSize:11, color:"#D46820", gap:10 }}>
                                <span>{p}</span>
                                <span
                                  style={{ cursor:"pointer", color:"#4ade80", fontSize:10, fontWeight:700, textTransform:"uppercase" }}
                                  onClick={function () { showPersonOnCard(activeCard, p); }}>show</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="tx-scroll">
                {loadingMonth
                  ? <div className="empty-msg">Loading…</div>
                  : (acd.transactions || []).length === 0
                    ? <div className="empty-msg">No transactions yet. Click "+ Add Transaction" below.</div>
                    : (
                      <table className="tx-tbl">
                        <thead>
                          <tr>
                            <th className="th" style={{ width:28 }} />
                            <th className="th name-col">Transaction Name</th>
                            <th className="th date-col">Date</th>
                            <th className="th inst-col">Installment</th>
                            {visiblePeople(activeCard).map(function (p) { return <th key={p} className="th amt-col">{p}</th>; })}
                            <th className="th amt-col">Row Total</th>
                            <th className="th act-col">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(acd.transactions || []).map(function (tx, i) {
                            const rt = txTotal(tx, people);
                            return (
                              <tr key={tx.id}
                                className={i % 2 === 0 ? "tr" : "tr alt"}
                                draggable
                                onDragStart={function () { onDragStart(i); }}
                                onDragEnter={function () { onDragEnter(i); }}
                                onDragEnd={function () { onDragEnd(activeCard); }}
                                onDragOver={function (e) { e.preventDefault(); }}
                                style={{ opacity: dragIdx.current === i ? 0.5 : 1 }}>
                                <td className="td drag-handle" title="Drag to reorder">⠿</td>
                                <td className="td">
                                  <input className="cell-inp" value={tx.name}
                                    placeholder="e.g. SM Supermarket"
                                    onChange={function (e) { updateTxField(activeCard, tx.id, "name", e.target.value); }}
                                    onBlur={function () { logEdit(activeCard, tx.name); }} />
                                </td>
                                <td className="td">
                                  <input className="cell-inp date-inp" type="date" value={tx.date}
                                    onChange={function (e) { updateTxField(activeCard, tx.id, "date", e.target.value); }}
                                    onBlur={function () { logEdit(activeCard, tx.name); }} />
                                </td>
                                <td className="td">
                                  <input className="cell-inp" value={tx.installment} placeholder="e.g. 2/36"
                                    onChange={function (e) { updateTxField(activeCard, tx.id, "installment", e.target.value); }}
                                    onBlur={function () { logEdit(activeCard, tx.name); }} />
                                </td>
                                {visiblePeople(activeCard).map(function (p) {
                                  return (
                                    <td key={p} className="td">
                                      <input className="cell-inp num-inp" type="number"
                                        value={tx.amounts[p] || ""} placeholder="—"
                                        onChange={function (e) { updateAmount(activeCard, tx.id, p, e.target.value); }}
                                        onBlur={function () { logEdit(activeCard, tx.name); }} />
                                    </td>
                                  );
                                })}
                                <td className="td">
                                  <span className={rt > 0 ? "row-tot on" : "row-tot"}>{rt > 0 ? fmtN(rt) : "—"}</span>
                                </td>
                                <td className="td">
                                  <div className="tx-actions">
                                    <button className="tx-act-btn move-btn" title="Move to another month"
                                      onClick={function () { setMoveModal({ txId: tx.id, toYear: year, toMonth: month === 11 ? 0 : month + 1 }); }}>↗</button>
                                    <button className="tx-act-btn del-btn" title="Remove"
                                      onClick={function () { removeTx(activeCard, tx.id); }}>×</button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="foot-row">
                            <td className="td" />
                            <td className="td foot-lbl" colSpan={3}>Column Totals</td>
                            {visiblePeople(activeCard).map(function (p) {
                              const t = cardPersonTotal(acd, p);
                              return <td key={p} className="td"><span className={t > 0 ? "col-tot on" : "col-tot"}>{t > 0 ? fmtN(t) : "—"}</span></td>;
                            })}
                            <td className="td"><span className="col-tot on grand">{fmtN(cardGrandTotal(acd, people))}</span></td>
                            <td className="td" />
                          </tr>
                        </tfoot>
                      </table>
                    )
                }
              </div>

              <div className="ed-footer">
                <button className="add-tx-btn" style={{ borderColor: meta.color + "60", color: meta.color }} onClick={function () { addTx(activeCard); }}>
                  + Add Transaction
                </button>
                {(acd.transactions || []).length > 0 && (
                  <button className="copy-tx-btn" onClick={function () { openCopyModal(activeCard); }}>⧉ Copy to Month</button>
                )}
                {(acd.transactions || []).length > 0 && (
                  <span className="tx-count">{acd.transactions.length} transaction{acd.transactions.length !== 1 ? "s" : ""}</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── SUMMARY / MY BILLS VIEW ── */}
        {view === "summary" && (
          <div className="summary-view">
            <div className="sum-heading">
              {isAdmin ? "Bills to Pay — " + MONTHS[month] + " " + year : "My Bills — " + MONTHS[month] + " " + year}
            </div>

            {isAdmin ? (
              /* Admin: full table with per-person paid toggles */
              <div className="sum-scroll">
                <table className="sum-tbl">
                  <thead>
                    <tr>
                      <th className="sth card-col">Card</th>
                      <th className="sth">Due Date</th>
                      {people.map(function (p) { return <th key={p} className="sth amt-col">{p}</th>; })}
                      <th className="sth amt-col">Card Total</th>
                      <th className="sth">Card Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cards.map(function (c) {
                      const cd    = getCard(year, month, c.id);
                      const grand = cardGrandTotal(cd, people);
                      return (
                        <tr key={c.id} className={cd.paid ? "str paid" : "str"}>
                          <td className="std" onClick={function () { setActiveCard(c.id); setView("detail"); }} style={{ cursor:"pointer" }}>
                            <div className="scard-name">
                              <span className="sdot" style={{ background: c.color }} />
                              <span>{c.name}</span>
                              {grand > 0 && <span className="s-stmt"> {fmt(grand)}</span>}
                            </div>
                          </td>
                          <td className="std"><span className="s-due">{cd.dueDay ? formatDate(cd.dueDay) : "—"}</span></td>
                          {people.map(function (p) {
                            const t      = cardPersonTotal(cd, p);
                            const isPaid = !!(cd.paidBy && cd.paidBy[p]);
                            return (
                              <td key={p} className="std amt-col">
                                {t > 0 ? (
                                  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
                                    <span className="s-amt">{fmtN(t)}</span>
                                    <span
                                      className={isPaid ? "person-paid-badge paid" : "person-paid-badge unpaid"}
                                      onClick={function () { togglePersonPaid(c.id, p); }}
                                      title={isPaid ? "Mark " + p + " unpaid" : "Mark " + p + " paid"}
                                      style={{ cursor:"pointer" }}>
                                      {isPaid ? "✓ Paid" : "Unpaid"}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="s-nil">—</span>
                                )}
                              </td>
                            );
                          })}
                          <td className="std amt-col"><span className={grand > 0 ? "s-grand" : "s-nil"}>{grand > 0 ? fmt(grand) : "—"}</span></td>
                          <td className="std">
                            <span
                              className={cd.paid ? "badge paid" : "badge unpaid"}
                              onClick={function () { togglePaid(c.id); }}
                              style={{ cursor:"pointer" }}
                              title="Toggle card paid status">
                              {cd.paid ? "Paid" : "Unpaid"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="sfoot">
                      <td className="std sfoot-lbl" colSpan={2}>Grand Total per Person</td>
                      {people.map(function (p) {
                        const t = grandPersonTotal(p);
                        return <td key={p} className="std amt-col"><span className={t > 0 ? "sfoot-tot" : "s-nil"}>{t > 0 ? fmt(t) : "—"}</span></td>;
                      })}
                      <td className="std amt-col"><span className="sfoot-grand">{fmt(cards.reduce(function (s, c) { return s + cardGrandTotal(getCard(year, month, c.id)); }, 0))}</span></td>
                      <td className="std" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              /* Non-admin: only their charges + self-toggle paid */
              <div className="my-bills-view">
                <div className="my-total-box">
                  <div className="my-total-label">Your total for {MONTHS[month]}</div>
                  <div className="my-total-amt">{fmt(grandPersonTotal(currentUser))}</div>
                </div>
                <div className="my-cards">
                  {cards.map(function (c) {
                    const cd = getCard(year, month, c.id);
                    const myTxs = (cd.transactions || []).filter(function (tx) { return toNum(tx.amounts[currentUser]) > 0; });
                    const myTotal = cardPersonTotal(cd, currentUser);
                    const iMePaid = !!(cd.paidBy && cd.paidBy[currentUser]);
                    if (myTotal === 0) return null;
                    return (
                      <div key={c.id} className="my-card">
                        <div className="my-card-header" style={{ borderColor: c.color + "50" }}>
                          <div className="my-card-name"><span className="bc-dot" style={{ background: c.color }} />{c.name}</div>
                          <div className="my-card-due">{cd.dueDay ? "Due: " + formatDate(cd.dueDay) : ""}</div>
                          <div className="my-card-total">{fmt(myTotal)}</div>
                          {/* Self-toggle paid */}
                          <span
                            className={iMePaid ? "badge paid" : "badge unpaid"}
                            onClick={function () { togglePersonPaid(c.id, currentUser); }}
                            style={{ cursor:"pointer" }}
                            title={iMePaid ? "Mark my share as unpaid" : "Mark my share as paid"}>
                            {iMePaid ? "✓ I Paid" : "Mark as Paid"}
                          </span>
                        </div>
                        <table className="my-tx-table">
                          <thead>
                            <tr>
                              <th className="my-th">Transaction</th>
                              <th className="my-th">Date</th>
                              <th className="my-th">Installment</th>
                              <th className="my-th" style={{ textAlign:"right" }}>Your Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {myTxs.map(function (tx) {
                              return (
                                <tr key={tx.id} className="my-tr">
                                  <td className="my-td">{tx.name}</td>
                                  <td className="my-td">{tx.date || "—"}</td>
                                  <td className="my-td">{tx.installment || "—"}</td>
                                  <td className="my-td" style={{ textAlign:"right", fontFamily:"Georgia,serif", color:"#F0EDE8" }}>{fmt(toNum(tx.amounts[currentUser]))}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                  {grandPersonTotal(currentUser) === 0 && (
                    <div className="empty-msg">No charges for you this month.</div>
                  )}
                </div>
              </div>
            )}

            {/* Per-person breakdown (admin only) */}
            {isAdmin && (
              <div className="breakdown-grid">
                {people.map(function (p) {
                  const total    = grandPersonTotal(p);
                  const hasCards = cards.filter(function (c) { return cardPersonTotal(getCard(year, month, c.id), p) > 0; });
                  // Count paid cards for this person
                  const paidCardCount = hasCards.filter(function (c) {
                    const cd = getCard(year, month, c.id);
                    return cd.paidBy && cd.paidBy[p];
                  }).length;
                  return (
                    <div key={p} className="bc">
                      <div className="bc-name">{p}</div>
                      <div className="bc-total">{total > 0 ? fmt(total) : "—"}</div>
                      {hasCards.length > 0 && (
                        <div style={{ fontSize:11, color: paidCardCount === hasCards.length ? "#34d399" : "#f87171", marginBottom:4 }}>
                          {paidCardCount}/{hasCards.length} cards paid
                        </div>
                      )}
                      <div className="bc-lines">
                        {hasCards.map(function (c) {
                          const cd     = getCard(year, month, c.id);
                          const t      = cardPersonTotal(cd, p);
                          const isPaid = !!(cd.paidBy && cd.paidBy[p]);
                          return (
                            <div key={c.id} className="bc-line">
                              <span className="bc-dot" style={{ background: c.color }} />
                              <span className="bc-cname">{c.name}</span>
                              <span className="bc-amt">{fmtN(t)}</span>
                              <span
                                className={isPaid ? "person-paid-badge paid" : "person-paid-badge unpaid"}
                                onClick={function () { togglePersonPaid(c.id, p); }}
                                style={{ cursor:"pointer", marginLeft:4 }}
                                title={isPaid ? "Mark unpaid" : "Mark paid"}>
                                {isPaid ? "✓" : "·"}
                              </span>
                            </div>
                          );
                        })}
                        {hasCards.length === 0 && <div className="bc-none">Nothing this month</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── AUDIT LOG VIEW ── */}
        {view === "audit" && (
          <div className="audit-view">
            <div className="audit-head-row">
              <div className="sum-heading">Change History</div>
              <select className="modal-sel" style={{ width:200 }} value={auditCard}
                onChange={function (e) { setAuditCard(e.target.value); }}>
                <option value="all">All Cards</option>
                {cards.map(function (c) { return <option key={c.id} value={c.name}>{c.name}</option>; })}
              </select>
            </div>
            <div className="audit-list">
              {filteredAudit.length === 0 && <div className="audit-empty">No history yet.</div>}
              {filteredAudit.map(function (e, i) {
                return (
                  <div key={i} className="audit-entry">
                    <div className="audit-action-tag" style={{ background: (actionColor[e.action] || "#888") + "22", color: actionColor[e.action] || "#888" }}>{e.action}</div>
                    <div className="audit-entry-body">
                      <div className="audit-entry-detail">{e.detail}</div>
                      <div className="audit-entry-meta">
                        <span className="audit-who-tag">{e.who}</span>
                        <span className="audit-month-tag">{e.month}</span>
                        <span className="audit-time">{timeAgo(e.ts)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
