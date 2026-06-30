(function () {
  "use strict";

  // ===== Supabase 설정 (anon public key — RLS로 보호되므로 공개 가능) =====
  // todo 앱과 동일한 프로젝트를 재사용한다.
  const SUPABASE_URL = "https://xblwokbylvlnwarxzioe.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhibHdva2J5bHZsbndhcnh6aW9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3NjEzNTgsImV4cCI6MjA5ODMzNzM1OH0.a0rKiBBfhJYtb1thc4xTLQ2in9mfpxsebFOlfVmGXP0";
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // OAuth 로그인 후 돌아올 주소 (Supabase Auth의 Site URL / Redirect URLs에 등록된 값과 일치해야 함)
  const REDIRECT_URL = "https://707extream.github.io/kanban-app/";

  const COLUMN_NAMES = ["todo", "in-progress", "done"];

  // ===== DOM 참조 =====
  const authView = document.getElementById("auth-view");
  const appView = document.getElementById("app-view");
  const authMessage = document.getElementById("auth-message");
  const githubBtn = document.getElementById("github-btn");
  const emailForm = document.getElementById("email-form");
  const emailInput = document.getElementById("email-input");
  const userArea = document.getElementById("user-area");
  const userEmail = document.getElementById("user-email");
  const logoutBtn = document.getElementById("logout-btn");

  const columns = Array.from(document.querySelectorAll(".column"));

  let cards = []; // [{ id, text, column_name, position }]
  let draggingCard = null;

  /* ===================== 인증 ===================== */
  async function signInWith(provider) {
    authMessage.textContent = "이동 중…";
    authMessage.className = "auth-message";
    const { error } = await db.auth.signInWithOAuth({
      provider,
      options: { redirectTo: REDIRECT_URL },
    });
    if (error) {
      console.error("로그인 실패:", error);
      authMessage.textContent = "로그인 실패: " + error.message;
      authMessage.className = "auth-message auth-message--error";
    }
  }

  // 이메일 매직링크 로그인 (외부 OAuth 앱 불필요 — Supabase Email provider만 켜면 됨)
  async function signInWithMagicLink(email) {
    authMessage.textContent = "메일 보내는 중…";
    authMessage.className = "auth-message";
    const { error } = await db.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: REDIRECT_URL },
    });
    if (error) {
      console.error("매직링크 발송 실패:", error);
      authMessage.textContent = "발송 실패: " + error.message;
      authMessage.className = "auth-message auth-message--error";
      return;
    }
    authMessage.textContent = email + " 로 로그인 링크를 보냈어요. 메일함을 확인하세요.";
    authMessage.className = "auth-message auth-message--ok";
  }

  githubBtn.addEventListener("click", () => signInWith("github"));
  emailForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    if (email) signInWithMagicLink(email);
  });
  logoutBtn.addEventListener("click", async () => {
    logoutBtn.disabled = true;
    try {
      // local 스코프: 서버 호출 실패와 무관하게 이 브라우저 세션을 정리
      const { error } = await db.auth.signOut({ scope: "local" });
      if (error) console.error("로그아웃 실패:", error);
    } catch (e) {
      console.error("로그아웃 예외:", e);
    } finally {
      // onAuthStateChange가 안 와도 화면은 무조건 로그아웃 상태로
      showLoggedOut();
      logoutBtn.disabled = false;
    }
  });

  function showLoggedIn(session) {
    authView.hidden = true;
    appView.hidden = false;
    userArea.hidden = false;
    userEmail.textContent = session.user.email || session.user.user_metadata?.name || "";
  }

  function showLoggedOut() {
    appView.hidden = true;
    userArea.hidden = true;
    authView.hidden = false;
    cards = [];
    columns.forEach((col) => (col.querySelector("[data-cards]").innerHTML = ""));
  }

  /* ===================== 데이터 (Supabase) ===================== */
  async function fetchCards() {
    const { data, error } = await db
      .from("cards")
      .select("*")
      .order("position", { ascending: true });
    if (error) {
      console.error("불러오기 실패:", error);
      return [];
    }
    return data || [];
  }

  async function insertCard(text, columnName) {
    const position = Date.now();
    const { data, error } = await db
      .from("cards")
      .insert({ text, column_name: columnName, position })
      .select()
      .single();
    if (error) {
      console.error("추가 실패:", error);
      alert("추가에 실패했습니다. (콘솔 확인)");
      return null;
    }
    return data;
  }

  async function removeCard(id) {
    const { error } = await db.from("cards").delete().eq("id", id);
    if (error) console.error("삭제 실패:", error);
  }

  async function persistMove(id, columnName, position) {
    const { error } = await db
      .from("cards")
      .update({ column_name: columnName, position })
      .eq("id", id);
    if (error) console.error("이동 갱신 실패:", error);
  }

  /* ===================== 렌더링 ===================== */
  function buildCardEl(card) {
    const el = document.createElement("div");
    el.className = "card";
    el.draggable = true;
    el.dataset.id = card.id;

    const span = document.createElement("span");
    span.className = "card-text";
    span.textContent = card.text;

    const del = document.createElement("button");
    del.className = "delete-btn";
    del.type = "button";
    del.setAttribute("aria-label", "카드 삭제");
    del.textContent = "×";
    del.addEventListener("click", async () => {
      el.remove();
      cards = cards.filter((c) => c.id !== card.id);
      updateCounts();
      await removeCard(card.id);
    });

    el.appendChild(span);
    el.appendChild(del);

    el.addEventListener("dragstart", () => {
      draggingCard = el;
      requestAnimationFrame(() => el.classList.add("dragging"));
    });
    el.addEventListener("dragend", onDragEnd);

    return el;
  }

  function render() {
    columns.forEach((col) => {
      const cardsEl = col.querySelector("[data-cards]");
      cardsEl.innerHTML = "";
      cards
        .filter((c) => c.column_name === col.dataset.column)
        .sort((a, b) => a.position - b.position)
        .forEach((c) => cardsEl.appendChild(buildCardEl(c)));
    });
    updateCounts();
  }

  function updateCounts() {
    columns.forEach((col) => {
      const count = col.querySelectorAll(".card").length;
      col.querySelector("[data-count]").textContent = count;
    });
  }

  /* ===================== 드래그 위치 계산 ===================== */
  // 커서 y좌표 기준으로, 바로 아래에 위치할 카드를 반환 (없으면 null = 맨 끝)
  function getCardAfter(container, y) {
    const els = Array.from(container.querySelectorAll(".card:not(.dragging)"));
    let closest = { offset: -Infinity, element: null };
    for (const el of els) {
      const box = el.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        closest = { offset, element: el };
      }
    }
    return closest.element;
  }

  // 드롭 완료: 새 컬럼/이웃 기준으로 position 계산 후 in-memory + DB 갱신
  async function onDragEnd() {
    const el = draggingCard;
    if (el) el.classList.remove("dragging");
    draggingCard = null;
    if (!el) return;

    const id = el.dataset.id;
    const card = cards.find((c) => String(c.id) === String(id));
    if (!card) return;

    const cardsEl = el.parentElement;
    const col = el.closest(".column");
    if (!col || !cardsEl) return;
    const newColumn = col.dataset.column;

    // 같은 컬럼 내 위/아래 이웃의 position으로 중간값 계산
    const siblings = Array.from(cardsEl.querySelectorAll(".card"));
    const idx = siblings.indexOf(el);
    const prevEl = siblings[idx - 1];
    const nextEl = siblings[idx + 1];
    const prev = prevEl ? cards.find((c) => String(c.id) === prevEl.dataset.id) : null;
    const next = nextEl ? cards.find((c) => String(c.id) === nextEl.dataset.id) : null;

    let newPosition;
    if (prev && next) newPosition = (prev.position + next.position) / 2;
    else if (prev) newPosition = prev.position + 1;
    else if (next) newPosition = next.position - 1;
    else newPosition = Date.now();

    const before = { column_name: card.column_name, position: card.position };
    // 변화 없으면 DB 호출 생략
    if (before.column_name === newColumn && before.position === card.position && !prev && !next) {
      updateCounts();
      return;
    }

    card.column_name = newColumn;
    card.position = newPosition;
    updateCounts();
    await persistMove(card.id, newColumn, newPosition);
  }

  /* ===================== 컬럼 이벤트 ===================== */
  columns.forEach((col) => {
    const cardsEl = col.querySelector("[data-cards]");

    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!draggingCard) return;
      col.classList.add("drag-over");
      const after = getCardAfter(cardsEl, e.clientY);
      if (after == null) cardsEl.appendChild(draggingCard);
      else cardsEl.insertBefore(draggingCard, after);
    });

    col.addEventListener("dragleave", (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove("drag-over");
    });

    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
    });

    // 카드 추가
    const form = col.querySelector("[data-add-form]");
    const input = col.querySelector("[data-add-input]");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      const saved = await insertCard(text, col.dataset.column);
      if (saved) {
        cards.push(saved);
        cardsEl.appendChild(buildCardEl(saved));
        updateCounts();
      }
    });
  });

  /* ===================== 인증 상태 흐름 ===================== */
  async function loadBoard(session) {
    showLoggedIn(session);
    cards = await fetchCards();
    render();
  }

  // OAuth 리다이렉트로 돌아왔을 때 URL(쿼리·해시)에 담긴 에러를 표면화
  function readAuthError() {
    const sources = [
      new URLSearchParams(window.location.search),
      new URLSearchParams(window.location.hash.replace(/^#/, "")),
    ];
    for (const p of sources) {
      const err = p.get("error") || p.get("error_code");
      if (err) {
        return p.get("error_description") || err;
      }
    }
    return null;
  }

  db.auth.onAuthStateChange(async (event, session) => {
    console.log("[auth]", event, session ? "session O" : "session X");
    if (event === "INITIAL_SESSION") return; // 아래 getSession에서 처리
    if (session) await loadBoard(session);
    else showLoggedOut();
  });

  (async () => {
    const urlError = readAuthError();
    if (urlError) {
      console.error("OAuth 리다이렉트 에러:", urlError);
      authMessage.textContent = "로그인 실패: " + urlError;
      authMessage.className = "auth-message auth-message--error";
    }

    const { data, error } = await db.auth.getSession();
    if (error) console.error("세션 조회 실패:", error);
    if (data.session) {
      // 토큰/code가 붙은 URL을 깨끗하게 정리
      if (window.location.search || window.location.hash) {
        history.replaceState(null, "", REDIRECT_URL);
      }
      await loadBoard(data.session);
    } else {
      showLoggedOut();
    }
  })();
})();
