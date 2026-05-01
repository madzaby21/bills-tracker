import React, { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import {
  doc,
  getDoc,
  setDoc,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  onSnapshot,
  where,
} from "firebase/firestore";
import "./styles.css";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const PEOPLE = ["Madz", "Aby", "Nick", "Joy", "Tin", "Rea", "Kuya Rodel"];
const ADMIN = "Madz"; // change this to your name — admin sees everything

const CARDS = [
  { id: "bdo_shopmore", name: "BDO Shopmore", color: "#B91C1C" },
  { id: "bdo_amex", name: "BDO AmEx", color: "#B45309" },
  { id: "bpi", name: "BPI", color: "#1D4ED8" },
  { id: "atome", name: "Atome", color: "#059669" },
  { id: "metro_platinum", name: "Metrobank Platinum", color: "#7C3AED" },
  { id: "metro_titanium", name: "Metrobank Titanium", color: "#475569" },
  { id: "shopee", name: "Shopee Pay Later", color: "#EA580C" },
  { id: "lazada", name: "Lazada Pay Later", color: "#2563EB" },
];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// ─── TYPES ───────────────────────────────────────────────────────────────────

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
  transactions: Transaction[];
}

interface MonthData {
  [cardId: string]: CardData;
}
interface Cache {
  [year: number]: { [month: number]: MonthData };
}

interface MoveModal {
  txId: string;
  toYear: number;
  toMonth: number;
}
interface CopyModal {
  fromCardId: string;
  toYear: number;
  toMonth: number;
  selectedTxIds: string[];
}

interface AuditEntry {
  id?: string;
  who: string;
  action: string; // "added" | "edited" | "removed" | "moved" | "copied" | "paid" | "unpaid"
  detail: string; // human-readable description
  card: string;
  month: string;
  ts: number;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function monthKey(y: number, m: number): string {
  return y + "-" + String(m + 1).padStart(2, "0");
}
function emptyCard(): CardData {
  return { dueDay: "", totalBill: "", paid: false, transactions: [] };
}
function emptyTx(): Omit<Transaction, "id"> {
  const amounts: { [p: string]: string } = {};
  PEOPLE.forEach(function (p) {
    amounts[p] = "";
  });
  return { name: "", date: "", installment: "", amounts };
}
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function toNum(s: string): number {
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function fmt(n: number): string {
  if (n === 0) return "—";
  return (
    "₱" +
    n.toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
function fmtN(n: number): string {
  if (n === 0) return "—";
  return n.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
function txTotal(tx: Transaction): number {
  return PEOPLE.reduce(function (s, p) {
    return s + toNum(tx.amounts[p]);
  }, 0);
}
function cardPersonTotal(card: CardData, person: string): number {
  return (card.transactions || []).reduce(function (s, tx) {
    return s + toNum(tx.amounts[person]);
  }, 0);
}
function cardGrandTotal(card: CardData): number {
  return PEOPLE.reduce(function (s, p) {
    return s + cardPersonTotal(card, p);
  }, 0);
}
function formatDate(d: string): string {
  if (!d) return "";
  try {
    const dt = new Date(d + "T00:00:00");
    return dt.toLocaleDateString("en-PH", { month: "short", day: "numeric" });
  } catch {
    return d;
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
  return Math.floor(diff / 86400000) + "d ago";
}

// ─── FIREBASE ────────────────────────────────────────────────────────────────

async function saveMonth(
  y: number,
  m: number,
  monthData: MonthData
): Promise<void> {
  await setDoc(doc(db, "bills_v3", monthKey(y, m)), {
    data: JSON.stringify(monthData),
  });
}
async function loadMonth(y: number, m: number): Promise<MonthData | null> {
  try {
    const snap = await getDoc(doc(db, "bills_v3", monthKey(y, m)));
    if (!snap.exists()) return null;
    const raw = snap.data();
    return raw?.data ? (JSON.parse(raw.data) as MonthData) : null;
  } catch {
    return null;
  }
}
async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await addDoc(collection(db, "audit"), { ...entry, ts: Date.now() });
  } catch {
    /* non-critical */
  }
}

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function App() {
  const today = new Date();

  // ── Identity ──
  const [currentUser, setCurrentUser] = useState<string>(() => {
    return localStorage.getItem("bills_user") || "";
  });
  const [nameInput, setNameInput] = useState("");
  const isAdmin = currentUser === ADMIN;

  // ── Data ──
  const [cache, setCache] = useState<Cache>({});
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [activeCard, setActiveCard] = useState(CARDS[0].id);
  const [view, setView] = useState<"detail" | "summary" | "audit">("detail");
  const [loadingMonth, setLoadingMonth] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saving" | "saved" | "error">(
    "saved"
  );
  const isLoadedRef = useRef(false);

  // ── Audit ──
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [auditCard, setAuditCard] = useState<string>("all");
  const [showHistory, setShowHistory] = useState(false);

  // ── Modals ──
  const [moveModal, setMoveModal] = useState<MoveModal | null>(null);
  const [copyModal, setCopyModal] = useState<CopyModal | null>(null);

  // ── Drag ──
  const dragIdx = useRef<number | null>(null);
  const dragOver = useRef<number | null>(null);

  // ── Banner ──
  const [banner, setBanner] = useState<{
    msg: string;
    type: "success" | "warn" | "error";
  } | null>(null);
  function showBanner(
    msg: string,
    type: "success" | "warn" | "error" = "success"
  ) {
    setBanner({ msg, type });
    setTimeout(function () {
      setBanner(null);
    }, 3000);
  }

  // ── Name setup ──────────────────────────────────────────────────────────

  function submitName() {
    const name = nameInput.trim();
    const matched = PEOPLE.find(function (p) {
      return p.toLowerCase() === name.toLowerCase();
    });
    if (!matched) {
      showBanner(
        "Name not recognized. Enter your exact name as listed.",
        "error"
      );
      return;
    }
    localStorage.setItem("bills_user", matched);
    setCurrentUser(matched);
  }

  // ── Load month ──────────────────────────────────────────────────────────

  useEffect(
    function () {
      if (cache[year] && cache[year][month] !== undefined) {
        isLoadedRef.current = true;
        return;
      }
      isLoadedRef.current = false;
      setLoadingMonth(true);
      loadMonth(year, month)
        .then(function (md) {
          setCache(function (prev) {
            const next = { ...prev };
            if (!next[year]) next[year] = {};
            next[year][month] = md || {};
            return next;
          });
          setLoadingMonth(false);
          isLoadedRef.current = true;
        })
        .catch(function () {
          setCache(function (prev) {
            const next = { ...prev };
            if (!next[year]) next[year] = {};
            next[year][month] = {};
            return next;
          });
          setLoadingMonth(false);
          isLoadedRef.current = true;
        });
    },
    [year, month]
  );

  // ── Auto-save ───────────────────────────────────────────────────────────

  useEffect(
    function () {
      if (!isLoadedRef.current) return;
      const monthData =
        cache[year] && cache[year][month] ? cache[year][month] : null;
      if (!monthData) return;
      setSaveStatus("saving");
      saveMonth(year, month, monthData)
        .then(function () {
          setSaveStatus("saved");
        })
        .catch(function () {
          setSaveStatus("error");
        });
    },
    [cache]
  );

  // ── Audit log listener ──────────────────────────────────────────────────

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

  // ── Data helpers ────────────────────────────────────────────────────────

  function getCard(y: number, m: number, cid: string): CardData {
    return cache[y] && cache[y][m] && cache[y][m][cid]
      ? cache[y][m][cid]
      : emptyCard();
  }

  function mutateCard(
    y: number,
    m: number,
    cid: string,
    fn: (c: CardData) => CardData
  ) {
    setCache(function (prev) {
      const next: Cache = JSON.parse(JSON.stringify(prev));
      if (!next[y]) next[y] = {};
      if (!next[y][m]) next[y][m] = {};
      next[y][m][cid] = fn(next[y][m][cid] || emptyCard());
      return next;
    });
  }

  function updateCardField(
    cid: string,
    field: "dueDay" | "totalBill",
    val: string
  ) {
    mutateCard(year, month, cid, function (c) {
      return { ...c, [field]: val };
    });
  }

  function togglePaid(cid: string) {
    const card = getCard(year, month, cid);
    const newPaid = !card.paid;
    mutateCard(year, month, cid, function (c) {
      return { ...c, paid: newPaid };
    });
    const cardName =
      CARDS.find(function (c) {
        return c.id === cid;
      })?.name || cid;
    logAudit({
      who: currentUser,
      action: newPaid ? "paid" : "unpaid",
      detail: cardName + " marked as " + (newPaid ? "Paid" : "Unpaid"),
      card: cardName,
      month: MONTHS[month] + " " + year,
      ts: Date.now(),
    });
  }

  function addTx(cid: string) {
    const newTx = { id: uid(), ...emptyTx() };
    mutateCard(year, month, cid, function (c) {
      return { ...c, transactions: [...(c.transactions || []), newTx] };
    });
    const cardName =
      CARDS.find(function (c) {
        return c.id === cid;
      })?.name || cid;
    logAudit({
      who: currentUser,
      action: "added",
      detail: "New transaction added to " + cardName,
      card: cardName,
      month: MONTHS[month] + " " + year,
      ts: Date.now(),
    });
  }

  function removeTx(cid: string, txId: string) {
    if (!window.confirm("Remove this transaction?")) return;
    const tx = getCard(year, month, cid).transactions.find(function (t) {
      return t.id === txId;
    });
    mutateCard(year, month, cid, function (c) {
      return {
        ...c,
        transactions: c.transactions.filter(function (t) {
          return t.id !== txId;
        }),
      };
    });
    const cardName =
      CARDS.find(function (c) {
        return c.id === cid;
      })?.name || cid;
    logAudit({
      who: currentUser,
      action: "removed",
      detail: 'Removed "' + (tx?.name || "transaction") + '" from ' + cardName,
      card: cardName,
      month: MONTHS[month] + " " + year,
      ts: Date.now(),
    });
  }

  function updateTxField(
    cid: string,
    txId: string,
    field: "name" | "date" | "installment",
    val: string
  ) {
    mutateCard(year, month, cid, function (c) {
      return {
        ...c,
        transactions: c.transactions.map(function (t) {
          return t.id === txId ? { ...t, [field]: val } : t;
        }),
      };
    });
  }

  function updateAmount(
    cid: string,
    txId: string,
    person: string,
    val: string
  ) {
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
    const cardName =
      CARDS.find(function (c) {
        return c.id === cid;
      })?.name || cid;
    logAudit({
      who: currentUser,
      action: "edited",
      detail: 'Edited "' + (txName || "transaction") + '" in ' + cardName,
      card: cardName,
      month: MONTHS[month] + " " + year,
      ts: Date.now(),
    });
  }

  // ── Drag to reorder ─────────────────────────────────────────────────────

  function onDragStart(idx: number) {
    dragIdx.current = idx;
  }
  function onDragEnter(idx: number) {
    dragOver.current = idx;
  }
  function onDragEnd(cid: string) {
    const from = dragIdx.current;
    const to = dragOver.current;
    if (from === null || to === null || from === to) return;
    mutateCard(year, month, cid, function (c) {
      const txs = [...c.transactions];
      const [moved] = txs.splice(from, 1);
      txs.splice(to, 0, moved);
      return { ...c, transactions: txs };
    });
    dragIdx.current = null;
    dragOver.current = null;
  }

  // ── Move transaction ────────────────────────────────────────────────────

  async function confirmMove() {
    if (!moveModal) return;
    const { txId, toYear, toMonth } = moveModal;
    const srcCard = getCard(year, month, activeCard);
    const tx = srcCard.transactions.find(function (t) {
      return t.id === txId;
    });
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
      return {
        ...c,
        transactions: c.transactions.filter(function (t) {
          return t.id !== txId;
        }),
      };
    });
    mutateCard(toYear, toMonth, activeCard, function (c) {
      return {
        ...c,
        transactions: [...(c.transactions || []), { ...tx, id: uid() }],
      };
    });

    const cardName =
      CARDS.find(function (c) {
        return c.id === activeCard;
      })?.name || activeCard;
    logAudit({
      who: currentUser,
      action: "moved",
      detail:
        'Moved "' +
        tx.name +
        '" from ' +
        MONTHS[month] +
        " " +
        year +
        " → " +
        MONTHS[toMonth] +
        " " +
        toYear,
      card: cardName,
      month: MONTHS[month] + " " + year,
      ts: Date.now(),
    });

    setMoveModal(null);
    showBanner("Moved to " + MONTHS[toMonth] + " " + toYear, "success");
  }

  // ── Copy transactions ───────────────────────────────────────────────────

  function openCopyModal(cid: string) {
    const srcCard = getCard(year, month, cid);
    if (!srcCard.transactions?.length) {
      showBanner("No transactions to copy", "warn");
      return;
    }
    setCopyModal({
      fromCardId: cid,
      toYear: year,
      toMonth: month === 11 ? 0 : month + 1,
      selectedTxIds: srcCard.transactions.map(function (t) {
        return t.id;
      }),
    });
  }

  function toggleCopyTx(txId: string) {
    setCopyModal(function (prev) {
      if (!prev) return prev;
      const already = prev.selectedTxIds.includes(txId);
      return {
        ...prev,
        selectedTxIds: already
          ? prev.selectedTxIds.filter(function (id) {
              return id !== txId;
            })
          : [...prev.selectedTxIds, txId],
      };
    });
  }

  async function confirmCopy() {
    if (!copyModal) return;
    const { fromCardId, toYear, toMonth, selectedTxIds } = copyModal;
    const srcCard = getCard(year, month, fromCardId);
    const txsToCopy = srcCard.transactions.filter(function (t) {
      return selectedTxIds.includes(t.id);
    });
    if (!txsToCopy.length) {
      showBanner("Select at least one transaction", "warn");
      return;
    }

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
      const newTxs = txsToCopy.map(function (t) {
        return { ...t, id: uid() };
      });
      return { ...c, transactions: [...(c.transactions || []), ...newTxs] };
    });

    const cardName =
      CARDS.find(function (c) {
        return c.id === fromCardId;
      })?.name || fromCardId;
    logAudit({
      who: currentUser,
      action: "copied",
      detail:
        "Copied " +
        txsToCopy.length +
        " transaction(s) to " +
        MONTHS[toMonth] +
        " " +
        toYear,
      card: cardName,
      month: MONTHS[month] + " " + year,
      ts: Date.now(),
    });

    setCopyModal(null);
    showBanner(
      "Copied " +
        txsToCopy.length +
        " transaction(s) to " +
        MONTHS[toMonth] +
        " " +
        toYear,
      "success"
    );
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  function prevMonth() {
    if (month === 0) {
      setMonth(11);
      setYear(function (y) {
        return y - 1;
      });
    } else
      setMonth(function (m) {
        return m - 1;
      });
  }
  function nextMonth() {
    if (month === 11) {
      setMonth(0);
      setYear(function (y) {
        return y + 1;
      });
    } else
      setMonth(function (m) {
        return m + 1;
      });
  }

  function grandPersonTotal(person: string): number {
    return CARDS.reduce(function (s, c) {
      return s + cardPersonTotal(getCard(year, month, c.id), person);
    }, 0);
  }

  // ── Name prompt screen ──────────────────────────────────────────────────

  if (!currentUser) {
    return (
      <div className="name-screen">
        <div className="name-box">
          <div className="name-title">Bills Tracker</div>
          <div className="name-sub">Enter your name to continue</div>
          {banner && (
            <div className={"banner banner-" + banner.type}>{banner.msg}</div>
          )}
          <input
            className="name-input"
            value={nameInput}
            onChange={function (e) {
              setNameInput(e.target.value);
            }}
            onKeyDown={function (e) {
              if (e.key === "Enter") submitName();
            }}
            placeholder="e.g. Madz, Aby, Nick…"
            autoFocus
          />
          <button className="name-btn" onClick={submitName}>
            Continue
          </button>
          <div className="name-hint">
            Your name is saved on this device. You won't need to enter it again.
          </div>
        </div>
      </div>
    );
  }

  // ── Main render ─────────────────────────────────────────────────────────

  const meta =
    CARDS.find(function (c) {
      return c.id === activeCard;
    }) || CARDS[0];
  const acd = getCard(year, month, activeCard);

  const filteredAudit =
    auditCard === "all"
      ? auditLog
      : auditLog.filter(function (e) {
          return e.card === auditCard;
        });

  const actionColor: { [k: string]: string } = {
    added: "#4ade80",
    removed: "#ef4444",
    edited: "#fbbf24",
    moved: "#60a5fa",
    copied: "#a78bfa",
    paid: "#34d399",
    unpaid: "#f87171",
  };

  return (
    <div className="app">
      {banner && (
        <div
          className={"banner banner-" + banner.type}
          style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999 }}
        >
          {banner.msg}
        </div>
      )}

      {/* ── MOVE MODAL ── */}
      {moveModal &&
        (function () {
          const tx = acd.transactions.find(function (t) {
            return t.id === moveModal.txId;
          });
          return (
            <div
              className="modal-backdrop"
              onClick={function () {
                setMoveModal(null);
              }}
            >
              <div
                className="modal"
                onClick={function (e) {
                  e.stopPropagation();
                }}
              >
                <div className="modal-title">Move Transaction</div>
                <div className="modal-tx-name">{tx?.name || "Transaction"}</div>
                <div className="modal-body">
                  <div className="modal-row">
                    <label className="modal-lbl">Move to Month</label>
                    <select
                      className="modal-sel"
                      value={moveModal.toMonth}
                      onChange={function (e) {
                        setMoveModal(function (p) {
                          return p ? { ...p, toMonth: +e.target.value } : p;
                        });
                      }}
                    >
                      {MONTHS.map(function (m, i) {
                        return (
                          <option key={i} value={i}>
                            {m}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  <div className="modal-row">
                    <label className="modal-lbl">Year</label>
                    <div className="modal-year-nav">
                      <button
                        className="modal-yr-btn"
                        onClick={function () {
                          setMoveModal(function (p) {
                            return p ? { ...p, toYear: p.toYear - 1 } : p;
                          });
                        }}
                      >
                        ‹
                      </button>
                      <span className="modal-yr">{moveModal.toYear}</span>
                      <button
                        className="modal-yr-btn"
                        onClick={function () {
                          setMoveModal(function (p) {
                            return p ? { ...p, toYear: p.toYear + 1 } : p;
                          });
                        }}
                      >
                        ›
                      </button>
                    </div>
                  </div>
                </div>
                <div className="modal-note">
                  From{" "}
                  <strong>
                    {MONTHS[month]} {year}
                  </strong>{" "}
                  →{" "}
                  <strong>
                    {MONTHS[moveModal.toMonth]} {moveModal.toYear}
                  </strong>
                </div>
                <div className="modal-actions">
                  <button
                    className="modal-cancel"
                    onClick={function () {
                      setMoveModal(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button className="modal-confirm" onClick={confirmMove}>
                    Move Transaction
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {/* ── COPY MODAL ── */}
      {copyModal &&
        (function () {
          const srcCard = getCard(year, month, copyModal.fromCardId);
          const cardMeta =
            CARDS.find(function (c) {
              return c.id === copyModal.fromCardId;
            }) || CARDS[0];
          return (
            <div
              className="modal-backdrop"
              onClick={function () {
                setCopyModal(null);
              }}
            >
              <div
                className="modal modal-wide"
                onClick={function (e) {
                  e.stopPropagation();
                }}
              >
                <div className="modal-title">Copy Transactions</div>
                <div
                  className="modal-tx-name"
                  style={{ color: cardMeta.color }}
                >
                  {cardMeta.name}
                </div>
                <div className="modal-body">
                  <div className="modal-row">
                    <label className="modal-lbl">Copy to Month</label>
                    <select
                      className="modal-sel"
                      value={copyModal.toMonth}
                      onChange={function (e) {
                        setCopyModal(function (p) {
                          return p ? { ...p, toMonth: +e.target.value } : p;
                        });
                      }}
                    >
                      {MONTHS.map(function (m, i) {
                        return (
                          <option key={i} value={i}>
                            {m}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  <div className="modal-row">
                    <label className="modal-lbl">Year</label>
                    <div className="modal-year-nav">
                      <button
                        className="modal-yr-btn"
                        onClick={function () {
                          setCopyModal(function (p) {
                            return p ? { ...p, toYear: p.toYear - 1 } : p;
                          });
                        }}
                      >
                        ‹
                      </button>
                      <span className="modal-yr">{copyModal.toYear}</span>
                      <button
                        className="modal-yr-btn"
                        onClick={function () {
                          setCopyModal(function (p) {
                            return p ? { ...p, toYear: p.toYear + 1 } : p;
                          });
                        }}
                      >
                        ›
                      </button>
                    </div>
                  </div>
                </div>
                <div className="copy-tx-list">
                  <div className="copy-tx-header">
                    <span>Select transactions to copy</span>
                    <div className="copy-sel-all">
                      <button
                        className="copy-sel-btn"
                        onClick={function () {
                          setCopyModal(function (p) {
                            return p
                              ? {
                                  ...p,
                                  selectedTxIds: srcCard.transactions.map(
                                    function (t) {
                                      return t.id;
                                    }
                                  ),
                                }
                              : p;
                          });
                        }}
                      >
                        All
                      </button>
                      <button
                        className="copy-sel-btn"
                        onClick={function () {
                          setCopyModal(function (p) {
                            return p ? { ...p, selectedTxIds: [] } : p;
                          });
                        }}
                      >
                        None
                      </button>
                    </div>
                  </div>
                  {srcCard.transactions.map(function (tx) {
                    const sel = copyModal.selectedTxIds.includes(tx.id);
                    return (
                      <div
                        key={tx.id}
                        className={sel ? "copy-tx-row selected" : "copy-tx-row"}
                        onClick={function () {
                          toggleCopyTx(tx.id);
                        }}
                      >
                        <div className={sel ? "copy-check on" : "copy-check"}>
                          {sel ? "✓" : ""}
                        </div>
                        <div className="copy-tx-info">
                          <span className="copy-tx-name">
                            {tx.name || "(unnamed)"}
                          </span>
                          {tx.installment && (
                            <span className="copy-tx-inst">
                              {tx.installment}
                            </span>
                          )}
                          {tx.date && (
                            <span className="copy-tx-date">{tx.date}</span>
                          )}
                        </div>
                        <div className="copy-tx-amt">{fmtN(txTotal(tx))}</div>
                      </div>
                    );
                  })}
                </div>
                <div className="modal-note">
                  Copying <strong>{copyModal.selectedTxIds.length}</strong>{" "}
                  transaction(s) →{" "}
                  <strong>
                    {MONTHS[copyModal.toMonth]} {copyModal.toYear}
                  </strong>
                </div>
                <div className="modal-actions">
                  <button
                    className="modal-cancel"
                    onClick={function () {
                      setCopyModal(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="modal-confirm"
                    onClick={confirmCopy}
                    disabled={copyModal.selectedTxIds.length === 0}
                  >
                    Copy{" "}
                    {copyModal.selectedTxIds.length > 0
                      ? "(" + copyModal.selectedTxIds.length + ")"
                      : ""}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {/* ── HEADER ── */}
      <div className="header">
        <div>
          <div className="app-title">Bills Tracker</div>
          <div className="app-subtitle">
            Viewing as <span style={{ color: "#fbbf24" }}>{currentUser}</span>
            {isAdmin && <span className="admin-badge">Admin</span>}
            <button
              className="switch-user-btn"
              onClick={function () {
                localStorage.removeItem("bills_user");
                setCurrentUser("");
                setNameInput("");
              }}
            >
              Switch
            </button>
          </div>
        </div>
        <div className="header-right">
          <div className="view-toggle">
            {isAdmin && (
              <button
                className={
                  view === "detail" ? "toggle-btn active" : "toggle-btn"
                }
                onClick={function () {
                  setView("detail");
                }}
              >
                Detail
              </button>
            )}
            <button
              className={
                view === "summary" ? "toggle-btn active" : "toggle-btn"
              }
              onClick={function () {
                setView("summary");
              }}
            >
              {isAdmin ? "Summary" : "My Bills"}
            </button>
            <button
              className={view === "audit" ? "toggle-btn active" : "toggle-btn"}
              onClick={function () {
                setView("audit");
              }}
            >
              History
            </button>
          </div>
          <div
            className={"save-dot " + saveStatus}
            title={
              saveStatus === "saving"
                ? "Saving…"
                : saveStatus === "error"
                ? "Save failed"
                : "All changes saved"
            }
          />
        </div>
      </div>

      <div className="content">
        {/* Month / Year nav */}
        <div className="topbar">
          <div className="month-nav">
            <button className="nav-arrow" onClick={prevMonth}>
              ‹
            </button>
            <div className="month-label">
              {MONTHS[month]} <span className="year-txt">{year}</span>
            </div>
            <button className="nav-arrow" onClick={nextMonth}>
              ›
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div className="year-picker">
              <button
                className="nav-arrow"
                onClick={function () {
                  setYear(function (y) {
                    return y - 1;
                  });
                }}
              >
                ‹
              </button>
              <div className="year-display">{year}</div>
              <button
                className="nav-arrow"
                onClick={function () {
                  setYear(function (y) {
                    return y + 1;
                  });
                }}
              >
                ›
              </button>
            </div>
            {loadingMonth && <div className="month-loading">Loading…</div>}
          </div>
        </div>

        {/* ── DETAIL VIEW (admin only) ── */}
        {view === "detail" && isAdmin && (
          <div className="detail-layout">
            <div className="sidebar">
              {CARDS.map(function (c) {
                const cd = getCard(year, month, c.id);
                const grand = cardGrandTotal(cd);
                const on = activeCard === c.id;
                return (
                  <button
                    key={c.id}
                    className={on ? "side-btn on" : "side-btn"}
                    style={
                      on
                        ? {
                            borderColor: c.color + "70",
                            background: c.color + "14",
                          }
                        : {}
                    }
                    onClick={function () {
                      setActiveCard(c.id);
                    }}
                  >
                    <div
                      className="side-dot"
                      style={{
                        background: c.color,
                        boxShadow: on ? "0 0 6px " + c.color : "none",
                      }}
                    />
                    <div className="side-info">
                      <div
                        className="side-name"
                        style={{ color: on ? "#fff" : "#999" }}
                      >
                        {c.name}
                      </div>
                      <div className="side-meta">
                        <span
                          className={grand > 0 ? "side-total" : "side-empty"}
                        >
                          {grand > 0 ? fmt(grand) : "No entries"}
                        </span>
                        {cd.dueDay && (
                          <span className="side-due">
                            {" "}
                            · due {formatDate(cd.dueDay)}
                          </span>
                        )}
                      </div>
                    </div>
                    {cd.paid && <span className="chk">✓</span>}
                  </button>
                );
              })}
            </div>

            <div className="editor" style={{ borderColor: meta.color + "35" }}>
              <div className="ed-head">
                <div
                  className="ed-dot"
                  style={{
                    background: meta.color,
                    boxShadow: "0 0 10px " + meta.color,
                  }}
                />
                <div className="ed-title">{meta.name}</div>
                <div className="spacer" />
                {/* History toggle for this card */}
                <button
                  className={showHistory ? "hist-btn on" : "hist-btn"}
                  onClick={function () {
                    setAuditCard(meta.name);
                    setShowHistory(function (v) {
                      return !v;
                    });
                  }}
                >
                  {showHistory ? "Hide History" : "History"}
                </button>
                <div className="ed-inputs">
                  <div className="ed-field">
                    <label className="ed-lbl">Due Date</label>
                    <input
                      className="ed-inp"
                      type="date"
                      value={acd.dueDay}
                      onChange={function (e) {
                        updateCardField(activeCard, "dueDay", e.target.value);
                      }}
                    />
                  </div>
                  <div className="ed-field">
                    <label className="ed-lbl">Statement Total (₱)</label>
                    <div className="auto-total">
                      {cardGrandTotal(acd) > 0 ? fmt(cardGrandTotal(acd)) : "—"}
                    </div>
                  </div>
                </div>
                <div
                  className={acd.paid ? "paid-pill on" : "paid-pill"}
                  onClick={function () {
                    togglePaid(activeCard);
                  }}
                >
                  <div className={acd.paid ? "pill-thumb on" : "pill-thumb"} />
                  <span>{acd.paid ? "Paid" : "Unpaid"}</span>
                </div>
              </div>

              {/* Inline history panel */}
              {showHistory && (
                <div className="inline-history">
                  {auditLog
                    .filter(function (e) {
                      return e.card === meta.name;
                    })
                    .slice(0, 15)
                    .map(function (e, i) {
                      return (
                        <div key={i} className="audit-row">
                          <span
                            className="audit-action"
                            style={{ color: actionColor[e.action] || "#888" }}
                          >
                            {e.action}
                          </span>
                          <span className="audit-who">{e.who}</span>
                          <span className="audit-detail">{e.detail}</span>
                          <span className="audit-time">{timeAgo(e.ts)}</span>
                        </div>
                      );
                    })}
                  {auditLog.filter(function (e) {
                    return e.card === meta.name;
                  }).length === 0 && (
                    <div className="audit-empty">
                      No history for this card yet.
                    </div>
                  )}
                </div>
              )}

              {(acd.transactions || []).length > 0 && (
                <div className="person-bar">
                  {PEOPLE.map(function (p) {
                    const t = cardPersonTotal(acd, p);
                    return (
                      <div key={p} className="person-chip">
                        <div className="pchip-name">{p}</div>
                        <div className={t > 0 ? "pchip-amt on" : "pchip-amt"}>
                          {t > 0 ? fmt(t) : "—"}
                        </div>
                      </div>
                    );
                  })}
                  <div className="person-chip grand-chip">
                    <div className="pchip-name">TOTAL</div>
                    <div className="pchip-amt on">
                      {fmt(cardGrandTotal(acd))}
                    </div>
                  </div>
                </div>
              )}

              <div className="tx-scroll">
                {loadingMonth ? (
                  <div className="empty-msg">Loading…</div>
                ) : (acd.transactions || []).length === 0 ? (
                  <div className="empty-msg">
                    No transactions yet. Click "+ Add Transaction" below.
                  </div>
                ) : (
                  <table className="tx-tbl">
                    <thead>
                      <tr>
                        <th className="th" style={{ width: 28 }} />
                        <th className="th name-col">Transaction Name</th>
                        <th className="th date-col">Date</th>
                        <th className="th inst-col">Installment</th>
                        {PEOPLE.map(function (p) {
                          return (
                            <th key={p} className="th amt-col">
                              {p}
                            </th>
                          );
                        })}
                        <th className="th amt-col">Row Total</th>
                        <th className="th act-col">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(acd.transactions || []).map(function (tx, i) {
                        const rt = txTotal(tx);
                        return (
                          <tr
                            key={tx.id}
                            className={i % 2 === 0 ? "tr" : "tr alt"}
                            draggable
                            onDragStart={function () {
                              onDragStart(i);
                            }}
                            onDragEnter={function () {
                              onDragEnter(i);
                            }}
                            onDragEnd={function () {
                              onDragEnd(activeCard);
                            }}
                            onDragOver={function (e) {
                              e.preventDefault();
                            }}
                            style={{ opacity: dragIdx.current === i ? 0.5 : 1 }}
                          >
                            <td
                              className="td drag-handle"
                              title="Drag to reorder"
                            >
                              ⠿
                            </td>
                            <td className="td">
                              <input
                                className="cell-inp"
                                value={tx.name}
                                placeholder="e.g. SM Supermarket"
                                onChange={function (e) {
                                  updateTxField(
                                    activeCard,
                                    tx.id,
                                    "name",
                                    e.target.value
                                  );
                                }}
                                onBlur={function () {
                                  logEdit(activeCard, tx.name);
                                }}
                              />
                            </td>
                            <td className="td">
                              <input
                                className="cell-inp date-inp"
                                type="date"
                                value={tx.date}
                                onChange={function (e) {
                                  updateTxField(
                                    activeCard,
                                    tx.id,
                                    "date",
                                    e.target.value
                                  );
                                }}
                                onBlur={function () {
                                  logEdit(activeCard, tx.name);
                                }}
                              />
                            </td>
                            <td className="td">
                              <input
                                className="cell-inp"
                                value={tx.installment}
                                placeholder="e.g. 2/36"
                                onChange={function (e) {
                                  updateTxField(
                                    activeCard,
                                    tx.id,
                                    "installment",
                                    e.target.value
                                  );
                                }}
                                onBlur={function () {
                                  logEdit(activeCard, tx.name);
                                }}
                              />
                            </td>
                            {PEOPLE.map(function (p) {
                              return (
                                <td key={p} className="td">
                                  <input
                                    className="cell-inp num-inp"
                                    type="number"
                                    value={tx.amounts[p] || ""}
                                    placeholder="—"
                                    onChange={function (e) {
                                      updateAmount(
                                        activeCard,
                                        tx.id,
                                        p,
                                        e.target.value
                                      );
                                    }}
                                    onBlur={function () {
                                      logEdit(activeCard, tx.name);
                                    }}
                                  />
                                </td>
                              );
                            })}
                            <td className="td">
                              <span
                                className={rt > 0 ? "row-tot on" : "row-tot"}
                              >
                                {rt > 0 ? fmtN(rt) : "—"}
                              </span>
                            </td>
                            <td className="td">
                              <div className="tx-actions">
                                <button
                                  className="tx-act-btn move-btn"
                                  title="Move to another month"
                                  onClick={function () {
                                    setMoveModal({
                                      txId: tx.id,
                                      toYear: year,
                                      toMonth: month === 11 ? 0 : month + 1,
                                    });
                                  }}
                                >
                                  ↗
                                </button>
                                <button
                                  className="tx-act-btn del-btn"
                                  title="Remove"
                                  onClick={function () {
                                    removeTx(activeCard, tx.id);
                                  }}
                                >
                                  ×
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="foot-row">
                        <td className="td" />
                        <td className="td foot-lbl" colSpan={3}>
                          Column Totals
                        </td>
                        {PEOPLE.map(function (p) {
                          const t = cardPersonTotal(acd, p);
                          return (
                            <td key={p} className="td">
                              <span
                                className={t > 0 ? "col-tot on" : "col-tot"}
                              >
                                {t > 0 ? fmtN(t) : "—"}
                              </span>
                            </td>
                          );
                        })}
                        <td className="td">
                          <span className="col-tot on grand">
                            {fmtN(cardGrandTotal(acd))}
                          </span>
                        </td>
                        <td className="td" />
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>

              <div className="ed-footer">
                <button
                  className="add-tx-btn"
                  style={{ borderColor: meta.color + "60", color: meta.color }}
                  onClick={function () {
                    addTx(activeCard);
                  }}
                >
                  + Add Transaction
                </button>
                {(acd.transactions || []).length > 0 && (
                  <button
                    className="copy-tx-btn"
                    onClick={function () {
                      openCopyModal(activeCard);
                    }}
                  >
                    ⧉ Copy to Month
                  </button>
                )}
                {(acd.transactions || []).length > 0 && (
                  <span className="tx-count">
                    {acd.transactions.length} transaction
                    {acd.transactions.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── SUMMARY / MY BILLS VIEW ── */}
        {view === "summary" && (
          <div className="summary-view">
            <div className="sum-heading">
              {isAdmin
                ? "Bills to Pay — " + MONTHS[month] + " " + year
                : "My Bills — " + MONTHS[month] + " " + year}
            </div>

            {isAdmin ? (
              /* Admin: full table */
              <div className="sum-scroll">
                <table className="sum-tbl">
                  <thead>
                    <tr>
                      <th className="sth card-col">Card</th>
                      <th className="sth">Due Date</th>
                      {PEOPLE.map(function (p) {
                        return (
                          <th key={p} className="sth amt-col">
                            {p}
                          </th>
                        );
                      })}
                      <th className="sth amt-col">Card Total</th>
                      <th className="sth">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CARDS.map(function (c) {
                      const cd = getCard(year, month, c.id);
                      const grand = cardGrandTotal(cd);
                      return (
                        <tr
                          key={c.id}
                          className={cd.paid ? "str paid" : "str"}
                          onClick={function () {
                            setActiveCard(c.id);
                            setView("detail");
                          }}
                        >
                          <td className="std">
                            <div className="scard-name">
                              <span
                                className="sdot"
                                style={{ background: c.color }}
                              />
                              <span>{c.name}</span>
                              {cardGrandTotal(cd) > 0 && (
                                <span className="s-stmt">
                                  {" "}
                                  {fmt(cardGrandTotal(cd))}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="std">
                            <span className="s-due">
                              {cd.dueDay ? formatDate(cd.dueDay) : "—"}
                            </span>
                          </td>
                          {PEOPLE.map(function (p) {
                            const t = cardPersonTotal(cd, p);
                            return (
                              <td key={p} className="std amt-col">
                                <span className={t > 0 ? "s-amt" : "s-nil"}>
                                  {t > 0 ? fmtN(t) : "—"}
                                </span>
                              </td>
                            );
                          })}
                          <td className="std amt-col">
                            <span className={grand > 0 ? "s-grand" : "s-nil"}>
                              {grand > 0 ? fmt(grand) : "—"}
                            </span>
                          </td>
                          <td className="std">
                            <span
                              className={
                                cd.paid ? "badge paid" : "badge unpaid"
                              }
                            >
                              {cd.paid ? "Paid" : "Unpaid"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="sfoot">
                      <td className="std sfoot-lbl" colSpan={2}>
                        Grand Total per Person
                      </td>
                      {PEOPLE.map(function (p) {
                        const t = grandPersonTotal(p);
                        return (
                          <td key={p} className="std amt-col">
                            <span className={t > 0 ? "sfoot-tot" : "s-nil"}>
                              {t > 0 ? fmt(t) : "—"}
                            </span>
                          </td>
                        );
                      })}
                      <td className="std amt-col">
                        <span className="sfoot-grand">
                          {fmt(
                            CARDS.reduce(function (s, c) {
                              return (
                                s + cardGrandTotal(getCard(year, month, c.id))
                              );
                            }, 0)
                          )}
                        </span>
                      </td>
                      <td className="std" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              /* Non-admin: only their charges */
              <div className="my-bills-view">
                <div className="my-total-box">
                  <div className="my-total-label">
                    Your total for {MONTHS[month]}
                  </div>
                  <div className="my-total-amt">
                    {fmt(grandPersonTotal(currentUser))}
                  </div>
                </div>
                <div className="my-cards">
                  {CARDS.map(function (c) {
                    const cd = getCard(year, month, c.id);
                    const myTxs = (cd.transactions || []).filter(function (tx) {
                      return toNum(tx.amounts[currentUser]) > 0;
                    });
                    const myTotal = cardPersonTotal(cd, currentUser);
                    if (myTotal === 0) return null;
                    return (
                      <div key={c.id} className="my-card">
                        <div
                          className="my-card-header"
                          style={{ borderColor: c.color + "50" }}
                        >
                          <div className="my-card-name">
                            <span
                              className="bc-dot"
                              style={{ background: c.color }}
                            />
                            {c.name}
                          </div>
                          <div className="my-card-due">
                            {cd.dueDay ? "Due: " + formatDate(cd.dueDay) : ""}
                          </div>
                          <div className="my-card-total">{fmt(myTotal)}</div>
                          <span
                            className={cd.paid ? "badge paid" : "badge unpaid"}
                          >
                            {cd.paid ? "Paid" : "Unpaid"}
                          </span>
                        </div>
                        <table className="my-tx-table">
                          <thead>
                            <tr>
                              <th className="my-th">Transaction</th>
                              <th className="my-th">Date</th>
                              <th className="my-th">Installment</th>
                              <th
                                className="my-th"
                                style={{ textAlign: "right" }}
                              >
                                Your Amount
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {myTxs.map(function (tx) {
                              return (
                                <tr key={tx.id} className="my-tr">
                                  <td className="my-td">{tx.name}</td>
                                  <td className="my-td">{tx.date || "—"}</td>
                                  <td className="my-td">
                                    {tx.installment || "—"}
                                  </td>
                                  <td
                                    className="my-td"
                                    style={{
                                      textAlign: "right",
                                      fontFamily: "Georgia,serif",
                                      color: "#F0EDE8",
                                    }}
                                  >
                                    {fmt(toNum(tx.amounts[currentUser]))}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                  {grandPersonTotal(currentUser) === 0 && (
                    <div className="empty-msg">
                      No charges for you this month.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Per-person breakdown (admin only) */}
            {isAdmin && (
              <div className="breakdown-grid">
                {PEOPLE.map(function (p) {
                  const total = grandPersonTotal(p);
                  const hasCards = CARDS.filter(function (c) {
                    return cardPersonTotal(getCard(year, month, c.id), p) > 0;
                  });
                  return (
                    <div key={p} className="bc">
                      <div className="bc-name">{p}</div>
                      <div className="bc-total">
                        {total > 0 ? fmt(total) : "—"}
                      </div>
                      <div className="bc-lines">
                        {hasCards.map(function (c) {
                          const t = cardPersonTotal(
                            getCard(year, month, c.id),
                            p
                          );
                          return (
                            <div key={c.id} className="bc-line">
                              <span
                                className="bc-dot"
                                style={{ background: c.color }}
                              />
                              <span className="bc-cname">{c.name}</span>
                              <span className="bc-amt">{fmtN(t)}</span>
                            </div>
                          );
                        })}
                        {hasCards.length === 0 && (
                          <div className="bc-none">Nothing this month</div>
                        )}
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
              <select
                className="modal-sel"
                style={{ width: 200 }}
                value={auditCard}
                onChange={function (e) {
                  setAuditCard(e.target.value);
                }}
              >
                <option value="all">All Cards</option>
                {CARDS.map(function (c) {
                  return (
                    <option key={c.id} value={c.name}>
                      {c.name}
                    </option>
                  );
                })}
              </select>
            </div>
            <div className="audit-list">
              {filteredAudit.length === 0 && (
                <div className="audit-empty">No history yet.</div>
              )}
              {filteredAudit.map(function (e, i) {
                return (
                  <div key={i} className="audit-entry">
                    <div
                      className="audit-action-tag"
                      style={{
                        background: (actionColor[e.action] || "#888") + "22",
                        color: actionColor[e.action] || "#888",
                      }}
                    >
                      {e.action}
                    </div>
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
