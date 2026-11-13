(() => {
  const BANNER_ID = "saarthii-caller-banner";
  const FAB_ID = "saarthii-floating-fab";
  const PANEL_ID = "saarthii-floating-panel";

  let currentActivePhone = null;
  let currentFullPhone = null;
  let currentChatKey = null;
  let currentLookupResult = null;
  let isPanelOpen = false;
  let debounceTimer = null;
  let bridgeReqCounter = 0;
  const pendingBridgeResolvers = new Map();

  // Receive resolved phone numbers from bridge.js (MAIN world: React Fiber / WA Store / IndexedDB)
  window.addEventListener("SAARTHII_RESOLVE_PHONE_RES", (e) => {
    const detail = e.detail || {};
    const { requestId, phone } = detail;
    if (requestId && pendingBridgeResolvers.has(requestId)) {
      const resolve = pendingBridgeResolvers.get(requestId);
      pendingBridgeResolvers.delete(requestId);
      resolve(phone || null);
    }
  });

  function requestPhoneFromBridge(lid, headerTitle) {
    return new Promise((resolve) => {
      const requestId = `req_${++bridgeReqCounter}_${Date.now()}`;
      pendingBridgeResolvers.set(requestId, resolve);

      window.dispatchEvent(
        new CustomEvent("SAARTHII_RESOLVE_PHONE_REQ", {
          detail: { requestId, lid, headerTitle }
        })
      );

      setTimeout(() => {
        if (pendingBridgeResolvers.has(requestId)) {
          pendingBridgeResolvers.delete(requestId);
          resolve(null);
        }
      }, 1500);
    });
  }

  // Debounced MutationObserver callback (250ms)
  function scheduleCheck() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      inspectActiveChat();
    }, 250);
  }

  // Normalize digits into { fullPhone, phone10 }
  function normalizePhoneDigits(raw) {
    if (!raw) return null;
    const digits = String(raw).replace(/\D+/g, "");
    if (digits.length < 10 || digits.length > 15) return null;
    return {
      fullPhone: digits,
      phone10: digits.slice(-10)
    };
  }

  function looksLikePhoneString(text) {
    if (!text) return false;
    const cleaned = text.trim();
    if (!/^[+\d\s\-().\u00A0\u202A-\u202E]+$/.test(cleaned)) return false;
    const digits = cleaned.replace(/\D+/g, "");
    return digits.length >= 10 && digits.length <= 15;
  }

  // Synchronous DOM extraction first
  function extractPhoneFromDOM(mainEl) {
    // 1. Unsaved Number in Header
    const headerSpans = mainEl.querySelectorAll('header span[dir="auto"], header span[title]');
    for (const span of headerSpans) {
      const candidateText = span.textContent || span.getAttribute("title") || "";
      if (looksLikePhoneString(candidateText)) {
        const normalized = normalizePhoneDigits(candidateText);
        if (normalized) return { ...normalized, source: "header" };
      }
    }

    // 2. Message Row data-id Attribute: [data-id*="@c.us"] inside #main
    const cUsElements = mainEl.querySelectorAll('[data-id*="@c.us"]');
    for (const el of cUsElements) {
      const dataId = el.getAttribute("data-id") || "";
      const match = dataId.match(/(?:^|_)(\d{10,15})@c\.us/);
      if (match && match[1]) {
        const normalized = normalizePhoneDigits(match[1]);
        if (normalized) return { ...normalized, source: "data-id" };
      }
    }

    // 3. Right-Side Contact Info Drawer (if open)
    const appRoot = document.querySelector("#app") || document.body;
    const allContainers = appRoot.querySelectorAll("aside, [data-testid='contact-info-drawer'], header ~ div, #main ~ div");
    const phoneRegex = /\+\d{1,3}[\s\d\-().\u00A0]{8,18}/g;
    const paneSide = document.querySelector("#pane-side");

    const searchRoots = allContainers.length > 0 ? allContainers : [appRoot];
    for (const root of searchRoots) {
      if (mainEl.contains(root)) continue;
      if (paneSide && (paneSide === root || paneSide.contains(root))) continue;

      const spans = root.querySelectorAll('span[dir="auto"], span[class], div[role="button"] span');
      for (const s of spans) {
        if (paneSide && paneSide.contains(s)) continue;
        if (mainEl.contains(s)) continue;
        const txt = (s.textContent || "").trim();
        if (txt.length >= 10 && txt.length <= 25) {
          const matched = txt.match(phoneRegex);
          if (matched && matched[0]) {
            const normalized = normalizePhoneDigits(matched[0]);
            if (normalized) return { ...normalized, source: "drawer" };
          }
        }
      }
    }

    // Extract @lid if present in #main [data-id*="@lid"]
    let lid = null;
    const lidEl = mainEl.querySelector('[data-id*="@lid"]');
    if (lidEl) {
      const rawId = lidEl.getAttribute("data-id") || "";
      const lidMatch = rawId.match(/(?:^|_)(\d+@lid)/);
      if (lidMatch && lidMatch[1]) {
        lid = lidMatch[1];
      }
    }

    const isGroup = Boolean(mainEl.querySelector('[data-id*="@g.us"]'));
    return {
      fullPhone: null,
      phone10: null,
      lid,
      isLid: Boolean(lidEl),
      isGroup
    };
  }

  function getHeaderTitle(mainEl) {
    const titleSpan = mainEl.querySelector('header span[dir="auto"]');
    return titleSpan ? (titleSpan.textContent || "").trim() : "";
  }

  // ==================== TOP BANNER UI ====================
  function ensureBanner(mainEl) {
    const header = mainEl.querySelector("header");
    if (!header) return null;

    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement("div");
      banner.id = BANNER_ID;
    }

    if (header.nextSibling !== banner) {
      header.insertAdjacentElement("afterend", banner);
    }

    return banner;
  }

  function renderBannerState(mainEl, stateObj) {
    currentLookupResult = stateObj;
    updateFloatingWidget(stateObj);

    const banner = ensureBanner(mainEl);
    if (!banner) return;

    banner.className = `saarthii-banner saarthii-state-${stateObj.state}`;
    banner.innerHTML = "";

    const left = document.createElement("div");
    left.className = "saarthii-banner-left";

    const dot = document.createElement("span");
    dot.className = "saarthii-status-dot";
    left.appendChild(dot);

    const content = document.createElement("div");
    content.className = "saarthii-banner-text";

    const right = document.createElement("div");
    right.className = "saarthii-banner-right";

    if (stateObj.state === "loading") {
      content.textContent = "Saarthii: Checking number...";
    } else if (stateObj.state === "found") {
      const nameStrong = document.createElement("strong");
      nameStrong.className = "saarthii-user-name";
      nameStrong.textContent = stateObj.name || "Client";
      content.appendChild(nameStrong);

      if (stateObj.agency) {
        const sep = document.createElement("span");
        sep.className = "saarthii-sep";
        sep.textContent = "•";
        content.appendChild(sep);

        const agencySpan = document.createElement("span");
        agencySpan.className = "saarthii-agency-name";
        agencySpan.textContent = stateObj.agency;
        content.appendChild(agencySpan);
      }

      if (Array.isArray(stateObj.extras) && stateObj.extras.length > 0) {
        for (const extra of stateObj.extras) {
          const pill = document.createElement("span");
          pill.className = "saarthii-extra-pill";
          pill.textContent = `${extra.label}: ${extra.value}`;
          content.appendChild(pill);
        }
      }

      const phoneTag = document.createElement("span");
      phoneTag.className = "saarthii-phone-subtle";
      phoneTag.textContent = `+91-${stateObj.phone10}`;
      right.appendChild(phoneTag);

      const detailsBtn = document.createElement("button");
      detailsBtn.type = "button";
      detailsBtn.className = "saarthii-open-drawer-btn";
      detailsBtn.textContent = "Details & Comment";
      detailsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFloatingPanel(true);
      });
      right.appendChild(detailsBtn);

      const refreshBtn = buildRefreshButton(stateObj.phone10, stateObj.fullPhone, mainEl);
      right.appendChild(refreshBtn);
    } else if (stateObj.state === "not_found") {
      const formatted = stateObj.phone10 ? `+91-${stateObj.phone10}` : "Unknown";
      content.textContent = `Unknown User (${formatted}) — Not in Saarthii`;

      const detailsBtn = document.createElement("button");
      detailsBtn.type = "button";
      detailsBtn.className = "saarthii-open-drawer-btn";
      detailsBtn.textContent = "+ Comment";
      detailsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFloatingPanel(true);
      });
      right.appendChild(detailsBtn);

      const refreshBtn = buildRefreshButton(stateObj.phone10, stateObj.fullPhone, mainEl);
      right.appendChild(refreshBtn);
    } else if (stateObj.state === "lid_prompt") {
      content.textContent = "Saved Contact (Click header to view number)";
      banner.style.cursor = "pointer";
      banner.title = "Click the chat header above to open Contact Info so Saarthii can read the phone number";
      banner.onclick = () => {
        const headerClickable = mainEl.querySelector("header [role='button'], header img, header span[dir='auto']");
        if (headerClickable) headerClickable.click();
      };
    } else if (stateObj.state === "unconfigured" || stateObj.state === "error") {
      content.textContent = stateObj.message || "Configure Saarthii API URL & Key in extension popup";
      if (stateObj.phone10) {
        const refreshBtn = buildRefreshButton(stateObj.phone10, stateObj.fullPhone, mainEl);
        right.appendChild(refreshBtn);
      }
    }

    if (stateObj.state !== "lid_prompt") {
      banner.style.cursor = "default";
      banner.onclick = null;
    }

    left.appendChild(content);
    banner.appendChild(left);
    banner.appendChild(right);
  }

  function buildRefreshButton(phone10, fullPhone, mainEl) {
    const btn = document.createElement("button");
    btn.className = "saarthii-refresh-btn";
    btn.type = "button";
    btn.title = "Force refresh from Saarthii Portal";
    btn.textContent = "↻";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      triggerLookup(mainEl, phone10, fullPhone, true);
    });
    return btn;
  }

  // ==================== BUYHATKE-STYLE FLOATING ICON & DRAWER ====================
  function ensureFloatingWidget() {
    let fab = document.getElementById(FAB_ID);
    if (!fab) {
      fab = document.createElement("div");
      fab.id = FAB_ID;
      fab.className = "saarthii-fab saarthii-fab-idle";
      fab.title = "Open Saarthii Portal Details & Comments";
      fab.innerHTML = `
        <div class="saarthii-fab-logo">S</div>
        <div class="saarthii-fab-label" id="saarthii-fab-label">Saarthii</div>
        <span class="saarthii-fab-dot" id="saarthii-fab-dot"></span>
      `;
      fab.addEventListener("click", () => {
        toggleFloatingPanel(!isPanelOpen);
      });
      document.body.appendChild(fab);
    }

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      panel.className = "saarthii-panel saarthii-panel-closed";
      document.body.appendChild(panel);
    }

    return { fab, panel };
  }

  function toggleFloatingPanel(open) {
    isPanelOpen = Boolean(open);
    const { panel, fab } = ensureFloatingWidget();
    if (isPanelOpen) {
      panel.classList.remove("saarthii-panel-closed");
      panel.classList.add("saarthii-panel-open");
      fab.classList.add("saarthii-fab-active");
      renderFloatingPanelContent(currentLookupResult);
    } else {
      panel.classList.remove("saarthii-panel-open");
      panel.classList.add("saarthii-panel-closed");
      fab.classList.remove("saarthii-fab-active");
    }
  }

  function updateFloatingWidget(stateObj) {
    const { fab } = ensureFloatingWidget();
    const labelEl = document.getElementById("saarthii-fab-label");
    const state = stateObj?.state || "idle";

    fab.className = `saarthii-fab saarthii-fab-${state} ${isPanelOpen ? "saarthii-fab-active" : ""}`;

    if (labelEl) {
      if (state === "found" && stateObj.name) {
        const shortName = stateObj.name.split(" ")[0].slice(0, 10);
        labelEl.textContent = shortName;
      } else if (state === "not_found") {
        labelEl.textContent = "Unknown";
      } else if (state === "loading") {
        labelEl.textContent = "Checking";
      } else {
        labelEl.textContent = "Saarthii";
      }
    }

    if (isPanelOpen) {
      renderFloatingPanelContent(stateObj);
    }
  }

  function renderFloatingPanelContent(stateObj) {
    const { panel } = ensureFloatingWidget();
    const mainEl = document.querySelector("#main");
    const chatTitle = mainEl ? getHeaderTitle(mainEl) : "";

    const phone10 = stateObj?.phone10 || currentActivePhone || "";
    const fullPhone = stateObj?.fullPhone || currentFullPhone || phone10;
    const isFound = stateObj?.state === "found";
    const displayName = isFound ? stateObj.name : chatTitle || "Unknown Contact";
    const displayAgency = isFound ? stateObj.agency : "";
    const initials = (displayName || "S")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("");

    const allDetails = Array.isArray(stateObj?.allDetails) ? stateObj.allDetails : [];
    const comments = Array.isArray(stateObj?.comments) ? stateObj.comments : [];

    panel.innerHTML = `
      <div class="saarthii-panel-header">
        <div class="saarthii-panel-brand">
          <div class="saarthii-panel-avatar">${escapeHtml(initials || "S")}</div>
          <div class="saarthii-panel-title-wrap">
            <div class="saarthii-panel-title">${escapeHtml(displayName)}</div>
            <div class="saarthii-panel-subtitle">
              ${
                displayAgency
                  ? escapeHtml(displayAgency)
                  : isFound
                  ? "Verified in Saarthii Portal"
                  : phone10
                  ? "Not Found in Saarthii Portal"
                  : "Open a chat in WhatsApp"
              }
            </div>
          </div>
        </div>
        <div class="saarthii-panel-header-actions">
          ${
            phone10
              ? `<button type="button" id="saarthii-panel-refresh" class="saarthii-icon-btn" title="Refresh Details">↻</button>`
              : ""
          }
          <button type="button" id="saarthii-panel-close" class="saarthii-icon-btn" title="Close Panel">✕</button>
        </div>
      </div>

      <div class="saarthii-panel-body">
        <!-- Phone bar -->
        <div class="saarthii-phone-card">
          <div>
            <div class="saarthii-card-label">PHONE NUMBER</div>
            <div class="saarthii-phone-value">${phone10 ? `+91 ${escapeHtml(phone10)}` : "No active phone detected"}</div>
          </div>
          ${
            phone10
              ? `<button type="button" id="saarthii-copy-phone" class="saarthii-chip-btn">Copy</button>`
              : ""
          }
        </div>

        <!-- Add Comment / Note to Portal Section -->
        <div class="saarthii-section">
          <div class="saarthii-section-header">
            <span>ADD COMMENT TO SAARTHII PORTAL</span>
          </div>
          <div class="saarthii-quick-tags">
            <button type="button" class="saarthii-tag-chip" data-tag="Follow-up required">Follow-up</button>
            <button type="button" class="saarthii-tag-chip" data-tag="Pricing shared on WhatsApp">Pricing Shared</button>
            <button type="button" class="saarthii-tag-chip" data-tag="Interested - Call back">Interested</button>
            <button type="button" class="saarthii-tag-chip" data-tag="Documents requested">Docs Asked</button>
          </div>
          <textarea
            id="saarthii-comment-input"
            class="saarthii-comment-textarea"
            rows="3"
            placeholder="${phone10 ? `Write a note/comment for +91-${phone10}...` : "Select a chat first to add a comment..."}"
            ${phone10 ? "" : "disabled"}
          ></textarea>
          <div class="saarthii-comment-actions">
            <div id="saarthii-comment-status" class="saarthii-comment-status"></div>
            <button
              type="button"
              id="saarthii-submit-comment"
              class="saarthii-submit-btn"
              ${phone10 ? "" : "disabled"}
            >
              Add Comment
            </button>
          </div>
        </div>

        <!-- Complete User / Agency Details -->
        <div class="saarthii-section">
          <div class="saarthii-section-header">
            <span>COMPLETE PORTAL DETAILS (${allDetails.length})</span>
          </div>
          ${
            allDetails.length > 0
              ? `<div class="saarthii-details-grid">
                  ${allDetails
                    .map(
                      (item) => `
                    <div class="saarthii-detail-row">
                      <span class="saarthii-detail-key">${escapeHtml(item.label)}</span>
                      <span class="saarthii-detail-val">${escapeHtml(item.value)}</span>
                    </div>
                  `
                    )
                    .join("")}
                </div>`
              : `<div class="saarthii-empty-box">
                  ${
                    stateObj?.state === "loading"
                      ? "Loading details from Saarthii Portal..."
                      : stateObj?.state === "unconfigured" || stateObj?.state === "error"
                      ? escapeHtml(stateObj.message || "Configure API URL & Key in extension popup.")
                      : phone10
                      ? "No client/agent record found in Saarthii Portal for this number."
                      : "Switch to a chat to view Saarthii Portal details."
                  }
                </div>`
          }
        </div>

        <!-- Recent Comments / Notes -->
        ${
          comments.length > 0
            ? `<div class="saarthii-section">
                <div class="saarthii-section-header">
                  <span>RECENT COMMENTS & NOTES (${comments.length})</span>
                </div>
                <div class="saarthii-comments-list">
                  ${comments
                    .map(
                      (c) => `
                    <div class="saarthii-comment-item">
                      <div class="saarthii-comment-text">${escapeHtml(c.text)}</div>
                      ${
                        c.author || c.createdAt
                          ? `<div class="saarthii-comment-meta">${escapeHtml(
                              [c.author, c.createdAt].filter(Boolean).join(" • ")
                            )}</div>`
                          : ""
                      }
                    </div>
                  `
                    )
                    .join("")}
                </div>
              </div>`
            : ""
        }
      </div>
    `;

    // Wire panel event listeners
    const closeBtn = document.getElementById("saarthii-panel-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => toggleFloatingPanel(false));
    }

    const refreshBtn = document.getElementById("saarthii-panel-refresh");
    if (refreshBtn && phone10) {
      refreshBtn.addEventListener("click", () => {
        const m = document.querySelector("#main");
        if (m) triggerLookup(m, phone10, fullPhone, true);
      });
    }

    const copyBtn = document.getElementById("saarthii-copy-phone");
    if (copyBtn && phone10) {
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(phone10).then(() => {
          copyBtn.textContent = "Copied!";
          setTimeout(() => {
            copyBtn.textContent = "Copy";
          }, 1500);
        });
      });
    }

    // Quick-tag chips
    const commentInput = document.getElementById("saarthii-comment-input");
    const tagButtons = panel.querySelectorAll(".saarthii-tag-chip");
    tagButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!commentInput || commentInput.disabled) return;
        const tagText = btn.getAttribute("data-tag") || "";
        const existing = commentInput.value.trim();
        commentInput.value = existing ? `${existing} — ${tagText}` : tagText;
        commentInput.focus();
      });
    });

    // Submit comment button
    const submitBtn = document.getElementById("saarthii-submit-comment");
    const statusEl = document.getElementById("saarthii-comment-status");
    if (submitBtn && commentInput) {
      submitBtn.addEventListener("click", () => {
        const text = commentInput.value.trim();
        if (!text) {
          if (statusEl) {
            statusEl.textContent = "Please enter a comment.";
            statusEl.className = "saarthii-comment-status saarthii-status-err";
          }
          return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = "Posting...";
        if (statusEl) {
          statusEl.textContent = "";
          statusEl.className = "saarthii-comment-status";
        }

        chrome.runtime.sendMessage(
          {
            type: "SAARTHII_ADD_COMMENT",
            phone10,
            fullPhone,
            comment: text,
            recordId: stateObj?.recordId || null,
            extraMeta: {
              chatName: displayName,
              agencyName: displayAgency
            }
          },
          (res) => {
            submitBtn.disabled = false;
            submitBtn.textContent = "Add Comment";

            if (chrome.runtime.lastError || !res) {
              if (statusEl) {
                statusEl.textContent = "Error communicating with extension.";
                statusEl.className = "saarthii-comment-status saarthii-status-err";
              }
              return;
            }

            if (!res.ok) {
              if (statusEl) {
                statusEl.textContent = res.message || "Failed to add comment";
                statusEl.className = "saarthii-comment-status saarthii-status-err";
              }
              return;
            }

            commentInput.value = "";
            if (statusEl) {
              statusEl.textContent = res.message || "Comment added!";
              statusEl.className = "saarthii-comment-status saarthii-status-ok";
            }

            // Append comment to local state immediately and re-render after brief delay
            if (currentLookupResult) {
              if (!Array.isArray(currentLookupResult.comments)) {
                currentLookupResult.comments = [];
              }
              currentLookupResult.comments.unshift({
                text,
                createdAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                author: "You (WhatsApp)"
              });
              setTimeout(() => {
                if (isPanelOpen) renderFloatingPanelContent(currentLookupResult);
              }, 800);
            }
          }
        );
      });
    }
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ==================== API LOOKUP TRIGGER ====================
  function triggerLookup(mainEl, phone10, fullPhone, forceRefresh = false) {
    renderBannerState(mainEl, { state: "loading", phone10, fullPhone });

    chrome.runtime.sendMessage(
      {
        type: "SAARTHII_LOOKUP",
        phone10,
        fullPhone,
        forceRefresh
      },
      (response) => {
        if (chrome.runtime.lastError) {
          renderBannerState(mainEl, {
            state: "error",
            phone10,
            fullPhone,
            message: "Extension reloaded — please refresh WhatsApp Web tab"
          });
          return;
        }

        if (currentActivePhone !== phone10) return;

        if (!response) {
          renderBannerState(mainEl, {
            state: "error",
            phone10,
            fullPhone,
            message: "Configure Saarthii API URL & Key in extension popup"
          });
          return;
        }

        renderBannerState(mainEl, response);
      }
    );
  }

  // ==================== ACTIVE CHAT INSPECTOR ====================
  async function inspectActiveChat() {
    ensureFloatingWidget();

    const mainEl = document.querySelector("#main");
    if (!mainEl) {
      currentActivePhone = null;
      currentFullPhone = null;
      currentChatKey = null;
      return;
    }

    const extracted = extractPhoneFromDOM(mainEl);
    const headerTitle = getHeaderTitle(mainEl);

    // 1. If DOM already gave us the phone number directly
    if (extracted.phone10) {
      const existingBanner = document.getElementById(BANNER_ID);
      if (currentActivePhone === extracted.phone10 && existingBanner && mainEl.contains(existingBanner)) {
        return;
      }

      currentActivePhone = extracted.phone10;
      currentFullPhone = extracted.fullPhone;
      currentChatKey = `phone:${extracted.phone10}`;
      triggerLookup(mainEl, extracted.phone10, extracted.fullPhone, false);
      return;
    }

    // 2. Group chats: hide banner
    if (extracted.isGroup) {
      const existingBanner = document.getElementById(BANNER_ID);
      if (existingBanner) existingBanner.remove();
      currentActivePhone = null;
      currentFullPhone = null;
      currentChatKey = "group";
      updateFloatingWidget({ state: "idle" });
      return;
    }

    // 3. Saved Contact / @lid chat where phone is NOT in DOM:
    // Automatically ask bridge.js (React Fiber + WA Internal Store + IndexedDB "model-storage")
    // so the user does NOT need to click/open the profile header!
    const bridgeCacheKey = `bridge:${extracted.lid || ""}:${headerTitle}`;
    if (currentChatKey === bridgeCacheKey && currentActivePhone) {
      return;
    }

    const resolvedRawPhone = await requestPhoneFromBridge(extracted.lid, headerTitle);
    const normalizedFromBridge = normalizePhoneDigits(resolvedRawPhone);

    // Re-verify #main is still on the same chat after async bridge lookup
    const latestMain = document.querySelector("#main");
    if (!latestMain || getHeaderTitle(latestMain) !== headerTitle) {
      return;
    }

    if (normalizedFromBridge && normalizedFromBridge.phone10) {
      const existingBanner = document.getElementById(BANNER_ID);
      if (
        currentActivePhone === normalizedFromBridge.phone10 &&
        existingBanner &&
        latestMain.contains(existingBanner)
      ) {
        return;
      }

      currentActivePhone = normalizedFromBridge.phone10;
      currentFullPhone = normalizedFromBridge.fullPhone;
      currentChatKey = bridgeCacheKey;
      triggerLookup(latestMain, normalizedFromBridge.phone10, normalizedFromBridge.fullPhone, false);
      return;
    }

    // 4. Last-resort fallback if even IndexedDB/Fiber didn't have a phone number yet
    const fallbackKey = `lid:${headerTitle}`;
    const existingBanner = document.getElementById(BANNER_ID);
    if (currentChatKey !== fallbackKey || !existingBanner || !latestMain.contains(existingBanner)) {
      currentActivePhone = null;
      currentFullPhone = null;
      currentChatKey = fallbackKey;
      renderBannerState(latestMain, { state: "lid_prompt" });
    }
  }

  // Re-trigger lookup when settings are updated in popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === "local" &&
      (changes.apiUrl ||
        changes.apiKey ||
        changes.httpMethod ||
        changes.phoneParam ||
        changes.authHeader ||
        changes.commentApiUrl)
    ) {
      const mainEl = document.querySelector("#main");
      if (mainEl && currentActivePhone) {
        triggerLookup(mainEl, currentActivePhone, currentFullPhone || currentActivePhone, true);
      }
    }
  });

  const observer = new MutationObserver(() => {
    scheduleCheck();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  scheduleCheck();
})();
