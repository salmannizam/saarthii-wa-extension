/**
 * bridge.js — Runs in WhatsApp Web's MAIN world.
 * Resolves the active chat's real phone number IMMEDIATELY without opening the Contact Info drawer,
 * even for Saved Contacts or @lid privacy IDs, using:
 *   1. React Fiber state/props attached to #main / header / message rows
 *   2. WhatsApp Web's internal Store / Collections (if exposed via require/webpack)
 *   3. WhatsApp Web's IndexedDB ("model-storage" -> contact & chat object stores)
 */
(() => {
  function cleanDigits(val) {
    if (!val) return null;
    const str = String(val);
    // If it's a @lid string without @c.us, don't treat the lid digits as a phone number
    if (str.includes("@lid") || str.includes("@g.us") || str.includes("@broadcast")) {
      return null;
    }
    const cUsMatch = str.match(/(?:^|_)(\d{10,15})@(?:c\.us|s\.whatsapp\.net)/);
    if (cUsMatch && cUsMatch[1]) {
      return cUsMatch[1];
    }
    const digits = str.replace(/\D+/g, "");
    if (digits.length >= 10 && digits.length <= 15) {
      return digits;
    }
    return null;
  }

  function extractPhoneFromWidOrContact(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 4) return null;

    // Direct Wid object { server: 'c.us', user: '919876543210' }
    if (obj.user && (obj.server === "c.us" || obj.server === "s.whatsapp.net")) {
      const d = cleanDigits(obj.user);
      if (d) return d;
    }

    if (typeof obj._serialized === "string" && obj._serialized.includes("@c.us")) {
      const d = cleanDigits(obj._serialized);
      if (d) return d;
    }

    // Contact / Chat model with phoneNumber property (used when primary id is @lid!)
    if (obj.phoneNumber) {
      if (typeof obj.phoneNumber === "string") {
        const d = cleanDigits(obj.phoneNumber);
        if (d) return d;
      } else if (typeof obj.phoneNumber === "object") {
        const d = extractPhoneFromWidOrContact(obj.phoneNumber, depth + 1);
        if (d) return d;
      }
    }

    // Check obj.id
    if (obj.id) {
      if (typeof obj.id === "string" && obj.id.includes("@c.us")) {
        const d = cleanDigits(obj.id);
        if (d) return d;
      } else if (typeof obj.id === "object") {
        const d = extractPhoneFromWidOrContact(obj.id, depth + 1);
        if (d) return d;
      }
    }

    // Check nested contact or chat
    if (obj.contact && typeof obj.contact === "object") {
      const d = extractPhoneFromWidOrContact(obj.contact, depth + 1);
      if (d) return d;
    }
    if (obj.chat && typeof obj.chat === "object") {
      const d = extractPhoneFromWidOrContact(obj.chat, depth + 1);
      if (d) return d;
    }
    if (obj.wid && typeof obj.wid === "object") {
      const d = extractPhoneFromWidOrContact(obj.wid, depth + 1);
      if (d) return d;
    }

    return null;
  }

  function extractLidFromObject(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 3) return null;
    if (obj.user && obj.server === "lid") {
      return `${obj.user}@lid`;
    }
    if (typeof obj._serialized === "string" && obj._serialized.endsWith("@lid")) {
      return obj._serialized;
    }
    if (typeof obj.id === "string" && obj.id.endsWith("@lid")) {
      return obj.id;
    }
    if (obj.id && typeof obj.id === "object") {
      const res = extractLidFromObject(obj.id, depth + 1);
      if (res) return res;
    }
    if (obj.chat && typeof obj.chat === "object") {
      const res = extractLidFromObject(obj.chat, depth + 1);
      if (res) return res;
    }
    if (obj.contact && typeof obj.contact === "object") {
      const res = extractLidFromObject(obj.contact, depth + 1);
      if (res) return res;
    }
    return null;
  }

  function getReactFiber(el) {
    if (!el) return null;
    const keys = Object.keys(el);
    for (const k of keys) {
      if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {
        return el[k];
      }
    }
    return null;
  }

  // 1. Inspect React Fiber tree on #main, #main header, and message rows
  function resolveFromReactFiber() {
    const mainEl = document.querySelector("#main");
    if (!mainEl) return { phone: null, lid: null };

    const targets = [
      mainEl,
      mainEl.querySelector("header"),
      mainEl.querySelector('header span[dir="auto"]'),
      mainEl.querySelector("[data-id]")
    ].filter(Boolean);

    let foundLid = null;

    for (const target of targets) {
      let fiber = getReactFiber(target);
      let steps = 0;

      while (fiber && steps < 40) {
        steps++;
        const props = fiber.memoizedProps || fiber.pendingProps;
        if (props && typeof props === "object") {
          const phone = extractPhoneFromWidOrContact(props);
          if (phone) return { phone, lid: foundLid, source: "react-fiber-props" };

          if (!foundLid) {
            foundLid = extractLidFromObject(props);
          }

          // Also scan top-level keys of props for chat/contact models
          for (const key of Object.keys(props)) {
            const val = props[key];
            if (val && typeof val === "object") {
              const p = extractPhoneFromWidOrContact(val);
              if (p) return { phone: p, lid: foundLid, source: `react-prop-${key}` };
              if (!foundLid) {
                foundLid = extractLidFromObject(val);
              }
            }
          }
        }

        // Check memoizedState linked list
        let stateNode = fiber.memoizedState;
        let stateSteps = 0;
        while (stateNode && stateSteps < 15) {
          stateSteps++;
          const memoVal = stateNode.memoizedState;
          if (memoVal && typeof memoVal === "object") {
            const p = extractPhoneFromWidOrContact(memoVal);
            if (p) return { phone: p, lid: foundLid, source: "react-state" };
            if (!foundLid) {
              foundLid = extractLidFromObject(memoVal);
            }
          }
          stateNode = stateNode.next;
        }

        fiber = fiber.return;
      }
    }

    return { phone: null, lid: foundLid };
  }

  // 2. Try WhatsApp internal require("WAWebChatCollection") / "WAWebContactCollection"
  function resolveFromWAInternalStore(lid, headerTitle) {
    try {
      if (typeof window.require !== "function") return null;

      let ChatCollection = null;
      let ContactCollection = null;
      try {
        const mod = window.require("WAWebChatCollection");
        ChatCollection = mod?.ChatCollection || mod?.default || mod;
      } catch {}
      try {
        const mod = window.require("WAWebContactCollection");
        ContactCollection = mod?.ContactCollection || mod?.default || mod;
      } catch {}

      if (ChatCollection && typeof ChatCollection.getModelsArray === "function") {
        const chats = ChatCollection.getModelsArray();
        const activeChat = chats.find((c) => c && c.active);
        if (activeChat) {
          const p = extractPhoneFromWidOrContact(activeChat);
          if (p) return { phone: p, source: "wa-active-chat" };
        }
      }

      if (ContactCollection && typeof ContactCollection.get === "function" && lid) {
        const contact = ContactCollection.get(lid);
        if (contact) {
          const p = extractPhoneFromWidOrContact(contact);
          if (p) return { phone: p, source: "wa-contact-lid" };
        }
      }

      if (ContactCollection && typeof ContactCollection.getModelsArray === "function" && headerTitle) {
        const contacts = ContactCollection.getModelsArray();
        const matched = contacts.find(
          (c) =>
            c &&
            (c.name === headerTitle ||
              c.formattedName === headerTitle ||
              c.shortName === headerTitle ||
              c.pushname === headerTitle)
        );
        if (matched) {
          const p = extractPhoneFromWidOrContact(matched);
          if (p) return { phone: p, source: "wa-contact-name" };
        }
      }
    } catch {
      // Ignore internal store errors
    }
    return null;
  }

  // 3. Query WhatsApp Web's IndexedDB ("model-storage") for contact / lid mapping
  function resolveFromIndexedDB(lid, headerTitle) {
    return new Promise((resolve) => {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }

      let resolved = false;
      const finish = (val) => {
        if (!resolved) {
          resolved = true;
          resolve(val);
        }
      };

      const timeout = setTimeout(() => finish(null), 1200);

      try {
        const req = indexedDB.open("model-storage");
        req.onerror = () => {
          clearTimeout(timeout);
          finish(null);
        };
        req.onsuccess = (event) => {
          const db = event.target.result;
          if (!db) {
            clearTimeout(timeout);
            finish(null);
            return;
          }

          const storeNames = Array.from(db.objectStoreNames || []);
          if (!storeNames.includes("contact")) {
            db.close();
            clearTimeout(timeout);
            finish(null);
            return;
          }

          try {
            const tx = db.transaction(["contact"], "readonly");
            const store = tx.objectStore("contact");

            // First try direct lookup by lid if available
            if (lid) {
              const getReq = store.get(lid);
              getReq.onsuccess = () => {
                const record = getReq.result;
                if (record) {
                  const p =
                    cleanDigits(record.phoneNumber) ||
                    cleanDigits(record.id);
                  if (p) {
                    db.close();
                    clearTimeout(timeout);
                    finish({ phone: p, source: "idb-lid" });
                    return;
                  }
                }
                scanAllContacts(store, db, lid, headerTitle, timeout, finish);
              };
              getReq.onerror = () => {
                scanAllContacts(store, db, lid, headerTitle, timeout, finish);
              };
            } else {
              scanAllContacts(store, db, lid, headerTitle, timeout, finish);
            }
          } catch {
            db.close();
            clearTimeout(timeout);
            finish(null);
          }
        };
      } catch {
        clearTimeout(timeout);
        finish(null);
      }
    });
  }

  function scanAllContacts(store, db, lid, headerTitle, timeout, finish) {
    try {
      const allReq = store.getAll();
      allReq.onsuccess = () => {
        const list = allReq.result || [];
        const cleanTitle = (headerTitle || "").trim().toLowerCase();

        // Pass 1: exact lid match in id or lid field
        if (lid) {
          for (const c of list) {
            if (!c) continue;
            if (c.id === lid || c.lid === lid || c.lidJid === lid) {
              const p = cleanDigits(c.phoneNumber) || cleanDigits(c.id);
              if (p) {
                db.close();
                clearTimeout(timeout);
                finish({ phone: p, source: "idb-contact-lid" });
                return;
              }
            }
          }
        }

        // Pass 2: exact saved contact name match
        if (cleanTitle) {
          // Prefer records that have a @c.us id or phoneNumber
          for (const c of list) {
            if (!c) continue;
            const cName = (c.name || "").trim().toLowerCase();
            const cShort = (c.shortName || "").trim().toLowerCase();
            const cVerified = (c.verifiedName || "").trim().toLowerCase();
            if (cName === cleanTitle || (cShort && cShort === cleanTitle) || (cVerified && cVerified === cleanTitle)) {
              const p = cleanDigits(c.phoneNumber) || cleanDigits(c.id);
              if (p) {
                db.close();
                clearTimeout(timeout);
                finish({ phone: p, source: "idb-contact-name" });
                return;
              }
            }
          }
        }

        db.close();
        clearTimeout(timeout);
        finish(null);
      };
      allReq.onerror = () => {
        db.close();
        clearTimeout(timeout);
        finish(null);
      };
    } catch {
      db.close();
      clearTimeout(timeout);
      finish(null);
    }
  }

  // Listen for requests from content.js via custom DOM event
  window.addEventListener("SAARTHII_RESOLVE_PHONE_REQ", async (e) => {
    const detail = e.detail || {};
    const { requestId, lid, headerTitle } = detail;

    // 1. Try React Fiber
    const fiberResult = resolveFromReactFiber();
    if (fiberResult && fiberResult.phone) {
      window.dispatchEvent(
        new CustomEvent("SAARTHII_RESOLVE_PHONE_RES", {
          detail: {
            requestId,
            phone: fiberResult.phone,
            source: fiberResult.source
          }
        })
      );
      return;
    }

    const effectiveLid = lid || fiberResult?.lid || null;

    // 2. Try WA Internal Store
    const storeResult = resolveFromWAInternalStore(effectiveLid, headerTitle);
    if (storeResult && storeResult.phone) {
      window.dispatchEvent(
        new CustomEvent("SAARTHII_RESOLVE_PHONE_RES", {
          detail: {
            requestId,
            phone: storeResult.phone,
            source: storeResult.source
          }
        })
      );
      return;
    }

    // 3. Try IndexedDB ("model-storage")
    const idbResult = await resolveFromIndexedDB(effectiveLid, headerTitle);
    window.dispatchEvent(
      new CustomEvent("SAARTHII_RESOLVE_PHONE_RES", {
        detail: {
          requestId,
          phone: idbResult?.phone || null,
          source: idbResult?.source || null
        }
      })
    );
  });
})();
