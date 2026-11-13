document.addEventListener("DOMContentLoaded", () => {
  const apiUrlInput = document.getElementById("apiUrl");
  const apiKeyInput = document.getElementById("apiKey");
  const httpMethodSelect = document.getElementById("httpMethod");
  const phoneParamInput = document.getElementById("phoneParam");
  const authHeaderInput = document.getElementById("authHeader");
  const commentApiUrlInput = document.getElementById("commentApiUrl");
  const commentParamInput = document.getElementById("commentParam");
  const saveBtn = document.getElementById("saveBtn");
  const clearCacheBtn = document.getElementById("clearCacheBtn");
  const statusMsg = document.getElementById("status-msg");

  function showStatus(text, isError = false) {
    statusMsg.textContent = text;
    statusMsg.className = isError ? "status-error" : "status-success";
    setTimeout(() => {
      if (statusMsg.textContent === text) {
        statusMsg.textContent = "";
      }
    }, 2500);
  }

  // Load existing settings
  chrome.storage.local.get(
    {
      apiUrl: "",
      apiKey: "",
      httpMethod: "GET",
      phoneParam: "phone",
      authHeader: "x-api-key",
      commentApiUrl: "",
      commentParam: "comment"
    },
    (items) => {
      apiUrlInput.value = items.apiUrl || "";
      apiKeyInput.value = items.apiKey || "";
      httpMethodSelect.value = items.httpMethod || "GET";
      phoneParamInput.value = items.phoneParam || "phone";
      authHeaderInput.value = items.authHeader || "x-api-key";
      commentApiUrlInput.value = items.commentApiUrl || "";
      commentParamInput.value = items.commentParam || "comment";
    }
  );

  // Save settings
  saveBtn.addEventListener("click", () => {
    const apiUrl = apiUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const httpMethod = httpMethodSelect.value;
    const phoneParam = phoneParamInput.value.trim() || "phone";
    const authHeader = authHeaderInput.value.trim() || "x-api-key";
    const commentApiUrl = commentApiUrlInput.value.trim();
    const commentParam = commentParamInput.value.trim() || "comment";

    if (!apiUrl) {
      showStatus("Please enter the Lookup API Endpoint URL", true);
      return;
    }

    chrome.storage.local.set(
      {
        apiUrl,
        apiKey,
        httpMethod,
        phoneParam,
        authHeader,
        commentApiUrl,
        commentParam
      },
      () => {
        chrome.runtime.sendMessage({ type: "SAARTHII_CLEAR_CACHE" }, () => {
          showStatus("Saved!");
        });
      }
    );
  });

  // Clear cache
  clearCacheBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "SAARTHII_CLEAR_CACHE" }, () => {
      showStatus("Cache cleared!");
    });
  });
});
