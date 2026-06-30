(function () {
  "use strict";

  // ===== Supabase 설정 (anon public key — RLS로 보호되므로 공개 가능) =====
  const SUPABASE_URL = "https://xblwokbylvlnwarxzioe.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhibHdva2J5bHZsbndhcnh6aW9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3NjEzNTgsImV4cCI6MjA5ODMzNzM1OH0.a0rKiBBfhJYtb1thc4xTLQ2in9mfpxsebFOlfVmGXP0";
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      flowType: "implicit",
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
      storageKey: "kanban-auth-token",
    },
  });

  const REDIRECT_URL = "https://707extream.github.io/kanban-app/";
  const COLUMN_NAMES = ["todo", "in-progress", "done"];
  const PRIORITY_LABEL = { low: "낮음", medium: "보통", high: "높음" };

  // ===== DOM 참조 =====
  const $ = (id) => document.getElementById(id);
  const authView = $("auth-view");
  const appView = $("app-view");
  const authMessage = $("auth-message");
  const githubBtn = $("github-btn");
  const emailForm = $("email-form");
  const emailInput = $("email-input");
  const userArea = $("user-area");
  const userEmail = $("user-email");
  const logoutBtn = $("logout-btn");

  const boardToolbar = $("board-toolbar");
  const boardSelect = $("board-select");
  const newBoardBtn = $("new-board-btn");
  const joinBoardBtn = $("join-board-btn");
  const shareBtn = $("share-btn");
  const toggleActivityBtn = $("toggle-activity-btn");

  const activityPanel = $("activity-panel");
  const activityList = $("activity-list");
  const closeActivityBtn = $("close-activity-btn");

  const columns = Array.from(document.querySelectorAll(".column"));

  // ===== 상태 =====
  let me = null;          // { id, email }
  let boards = [];        // [{ id, name, invite_code, owner_id }]
  let currentBoardId = null;
  let cards = [];         // 현재 보드의 카드
  let draggingCard = null;
  let channel = null;     // realtime 구독

  /* ===================== 인증 ===================== */
  async function signInWith(provider) {
    authMessage.textContent = "이동 중…";
    authMessage.className = "auth-message";
    const { error } = await db.auth.signInWithOAuth({
      provider,
      options: { redirectTo: REDIRECT_URL },
    });
    if (error) showAuthError("로그인 실패: " + error.message);
  }

  async function signInWithMagicLink(email) {
    authMessage.textContent = "메일 보내는 중…";
    authMessage.className = "auth-message";
    const { error } = await db.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: REDIRECT_URL },
    });
    if (error) return showAuthError("발송 실패: " + error.message);
    authMessage.textContent = email + " 로 로그인 링크를 보냈어요. 메일함을 확인하세요.";
    authMessage.className = "auth-message auth-message--ok";
  }

  function showAuthError(msg) {
    console.error(msg);
    authMessage.textContent = msg;
    authMessage.className = "auth-message auth-message--error";
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
      await db.auth.signOut({ scope: "local" });
    } catch (e) {
      console.error("로그아웃 예외:", e);
    } finally {
      unsubscribeRealtime();
      showLoggedOut();
      logoutBtn.disabled = false;
    }
  });

  function showLoggedIn(session) {
    me = { id: session.user.id, email: session.user.email || "" };
    authView.hidden = true;
    appView.hidden = false;
    userArea.hidden = false;
    boardToolbar.hidden = false;
    userEmail.textContent = me.email || session.user.user_metadata?.name || "";
  }

  function showLoggedOut() {
    me = null;
    boards = [];
    currentBoardId = null;
    cards = [];
    appView.hidden = true;
    userArea.hidden = true;
    boardToolbar.hidden = true;
    authView.hidden = false;
    columns.forEach((col) => (col.querySelector("[data-cards]").innerHTML = ""));
  }

  /* ===================== 보드 ===================== */
  async function loadBoards() {
    // 내가 멤버인 보드 목록
    const { data: memberships, error } = await db
      .from("board_members")
      .select("board_id, boards(id, name, invite_code, owner_id, created_at)");
    if (error) {
      console.error("보드 목록 실패:", error);
      return [];
    }
    return (memberships || [])
      .map((m) => m.boards)
      .filter(Boolean)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  function renderBoardSelect() {
    boardSelect.innerHTML = "";
    boards.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.name + (b.owner_id === me.id ? " (내 보드)" : " (공유됨)");
      boardSelect.appendChild(opt);
    });
    boardSelect.value = currentBoardId || "";
  }

  function currentBoard() {
    return boards.find((b) => b.id === currentBoardId) || null;
  }

  async function switchBoard(boardId) {
    currentBoardId = boardId;
    boardSelect.value = boardId;
    cards = await fetchCards(boardId);
    render();
    await refreshActivity();
    subscribeRealtime(boardId);
  }

  boardSelect.addEventListener("change", () => switchBoard(boardSelect.value));

  newBoardBtn.addEventListener("click", async () => {
    const name = prompt("새 보드 이름:", "새 보드");
    if (name == null) return;
    const { data, error } = await db
      .from("boards")
      .insert({ name: name.trim() || "새 보드" })
      .select()
      .single();
    if (error) {
      console.error("보드 생성 실패:", error);
      return toast("보드 생성 실패: " + error.message + " — DB 설정(§1-B SQL)을 실행했는지 확인하세요.", true);
    }
    boards.push(data);
    renderBoardSelect();
    await switchBoard(data.id);
    toast("새 보드를 만들었어요.");
  });

  /* ===================== 데이터: 카드 ===================== */
  async function fetchCards(boardId) {
    const { data, error } = await db
      .from("cards")
      .select("*")
      .eq("board_id", boardId)
      .order("position", { ascending: true });
    if (error) {
      console.error("카드 불러오기 실패:", error);
      return [];
    }
    return data || [];
  }

  async function insertCard(text, columnName) {
    const position = Date.now();
    const { data, error } = await db
      .from("cards")
      .insert({ text, column_name: columnName, position, board_id: currentBoardId })
      .select()
      .single();
    if (error) {
      console.error("추가 실패:", error);
      toast("카드 추가 실패: " + error.message, true);
      return null;
    }
    logActivity("추가", `"${text}" (${columnLabel(columnName)})`);
    return data;
  }

  async function updateCardFields(id, fields) {
    const { error } = await db.from("cards").update(fields).eq("id", id);
    if (error) console.error("카드 수정 실패:", error);
  }

  async function removeCard(id, text) {
    const { error } = await db.from("cards").delete().eq("id", id);
    if (error) return console.error("삭제 실패:", error);
    logActivity("삭제", `"${text}"`);
  }

  async function persistMove(id, columnName, position) {
    const { error } = await db
      .from("cards")
      .update({ column_name: columnName, position })
      .eq("id", id);
    if (error) console.error("이동 갱신 실패:", error);
  }

  function columnLabel(name) {
    return { todo: "To-Do", "in-progress": "In-Progress", done: "Done" }[name] || name;
  }

  /* ===================== 활동 로그 ===================== */
  async function logActivity(action, detail) {
    if (!currentBoardId || !me) return;
    const { error } = await db.from("activity_log").insert({
      board_id: currentBoardId,
      user_id: me.id,
      user_email: me.email,
      action,
      detail,
    });
    if (error) console.error("활동 기록 실패:", error);
  }

  async function refreshActivity() {
    if (!currentBoardId) return;
    const { data, error } = await db
      .from("activity_log")
      .select("*")
      .eq("board_id", currentBoardId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return console.error("활동 조회 실패:", error);
    renderActivity(data || []);
  }

  function renderActivity(items) {
    activityList.innerHTML = "";
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "activity-empty";
      li.textContent = "아직 활동이 없어요.";
      activityList.appendChild(li);
      return;
    }
    items.forEach((a) => activityList.appendChild(buildActivityEl(a)));
  }

  function buildActivityEl(a) {
    const li = document.createElement("li");
    li.className = "activity-item";
    const who = (a.user_email || "누군가").split("@")[0];
    const when = formatTime(a.created_at);
    li.innerHTML =
      `<span class="act-who">${escapeHtml(who)}</span>` +
      `<span class="act-action">${escapeHtml(a.action)}</span>` +
      (a.detail ? `<span class="act-detail">${escapeHtml(a.detail)}</span>` : "") +
      `<span class="act-when">${when}</span>`;
    return li;
  }

  function formatTime(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  toggleActivityBtn.addEventListener("click", () => {
    activityPanel.hidden = !activityPanel.hidden;
    if (!activityPanel.hidden) refreshActivity();
  });
  closeActivityBtn.addEventListener("click", () => (activityPanel.hidden = true));

  /* ===================== 카드 렌더링 ===================== */
  function buildCardEl(card) {
    const el = document.createElement("div");
    el.className = "card priority-" + (card.priority || "medium");
    el.draggable = true;
    el.dataset.id = card.id;

    const main = document.createElement("div");
    main.className = "card-main";

    const span = document.createElement("span");
    span.className = "card-text";
    span.textContent = card.text;
    main.appendChild(span);

    // 메타 배지
    const meta = document.createElement("div");
    meta.className = "card-meta";
    meta.appendChild(badge("priority", `우선순위 ${PRIORITY_LABEL[card.priority] || "보통"}`));
    if (card.due_date) {
      const overdue = isOverdue(card.due_date) && card.column_name !== "done";
      meta.appendChild(badge("due" + (overdue ? " overdue" : ""), "📅 " + card.due_date));
    }
    (card.tags || []).forEach((t) => meta.appendChild(badge("tag", "#" + t)));
    if (meta.children.length) main.appendChild(meta);

    el.appendChild(main);

    // 액션: 편집 / 삭제
    const actions = document.createElement("div");
    actions.className = "card-actions";
    const edit = iconButton("✎", "카드 편집", (e) => {
      e.stopPropagation();
      openCardModal(card);
    });
    const del = iconButton("×", "카드 삭제", async (e) => {
      e.stopPropagation();
      el.remove();
      cards = cards.filter((c) => c.id !== card.id);
      updateCounts();
      await removeCard(card.id, card.text);
    });
    del.classList.add("delete-btn");
    actions.appendChild(edit);
    actions.appendChild(del);
    el.appendChild(actions);

    el.addEventListener("dragstart", () => {
      draggingCard = el;
      requestAnimationFrame(() => el.classList.add("dragging"));
    });
    el.addEventListener("dragend", onDragEnd);

    return el;
  }

  function badge(cls, text) {
    const b = document.createElement("span");
    b.className = "badge badge-" + cls;
    b.textContent = text;
    return b;
  }

  function iconButton(label, aria, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon-btn";
    b.setAttribute("aria-label", aria);
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function isOverdue(dateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return new Date(dateStr) < today;
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

  /* ===================== 카드 편집 모달 ===================== */
  const cardModal = $("card-modal");
  const cardForm = $("card-form");
  const cardTextInput = $("card-text");
  const cardPriorityInput = $("card-priority");
  const cardDueInput = $("card-due");
  const cardTagsInput = $("card-tags");
  let editingCardId = null;

  function openCardModal(card) {
    editingCardId = card.id;
    cardTextInput.value = card.text;
    cardPriorityInput.value = card.priority || "medium";
    cardDueInput.value = card.due_date || "";
    cardTagsInput.value = (card.tags || []).join(", ");
    cardModal.hidden = false;
  }

  cardForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const card = cards.find((c) => c.id === editingCardId);
    if (!card) return;
    const tags = cardTagsInput.value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const fields = {
      text: cardTextInput.value.trim() || card.text,
      priority: cardPriorityInput.value,
      due_date: cardDueInput.value || null,
      tags,
    };
    Object.assign(card, fields);
    render();
    cardModal.hidden = true;
    await updateCardFields(card.id, fields);
    logActivity("편집", `"${fields.text}"`);
  });

  /* ===================== 드래그 위치 계산 ===================== */
  function getCardAfter(container, y) {
    const els = Array.from(container.querySelectorAll(".card:not(.dragging)"));
    let closest = { offset: -Infinity, element: null };
    for (const el of els) {
      const box = el.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) closest = { offset, element: el };
    }
    return closest.element;
  }

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
    const prevColumn = card.column_name;

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

    if (prevColumn === newColumn && card.position === newPosition && !prev && !next) {
      updateCounts();
      return;
    }

    card.column_name = newColumn;
    card.position = newPosition;
    updateCounts();
    await persistMove(card.id, newColumn, newPosition);
    if (prevColumn !== newColumn) {
      logActivity("이동", `"${card.text}" → ${columnLabel(newColumn)}`);
    }
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

    const form = col.querySelector("[data-add-form]");
    const input = col.querySelector("[data-add-input]");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      if (!currentBoardId) {
        return toast("보드가 없습니다. DB 설정(§1-B SQL) 실행 여부를 확인하세요.", true);
      }
      input.value = "";
      const saved = await insertCard(text, col.dataset.column);
      if (saved) {
        cards.push(saved);
        cardsEl.appendChild(buildCardEl(saved));
        updateCounts();
      }
    });
  });

  /* ===================== 공유 모달 ===================== */
  const shareModal = $("share-modal");
  const inviteCodeInput = $("invite-code");
  const copyCodeBtn = $("copy-code-btn");
  const inviteForm = $("invite-form");
  const inviteEmail = $("invite-email");
  const shareMessage = $("share-message");
  const memberList = $("member-list");

  shareBtn.addEventListener("click", async () => {
    const b = currentBoard();
    if (!b) return;
    inviteCodeInput.value = b.invite_code;
    shareMessage.textContent = "";
    shareMessage.className = "modal-message";
    inviteEmail.value = "";
    shareModal.hidden = false;
    await refreshMembers();
  });

  copyCodeBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inviteCodeInput.value);
      copyCodeBtn.textContent = "복사됨!";
      setTimeout(() => (copyCodeBtn.textContent = "복사"), 1500);
    } catch {
      inviteCodeInput.select();
      document.execCommand("copy");
    }
  });

  inviteForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = inviteEmail.value.trim();
    if (!email) return;
    const { error } = await db.rpc("invite_member_by_email", {
      p_board: currentBoardId,
      p_email: email,
    });
    if (error) {
      shareMessage.textContent = "초대 실패: " + error.message;
      shareMessage.className = "modal-message modal-message--error";
      return;
    }
    shareMessage.textContent = email + " 님을 초대했어요.";
    shareMessage.className = "modal-message modal-message--ok";
    inviteEmail.value = "";
    logActivity("초대", email);
    await refreshMembers();
  });

  async function refreshMembers() {
    const { data: members, error } = await db
      .from("board_members")
      .select("user_id, role")
      .eq("board_id", currentBoardId);
    if (error) {
      console.error("멤버 조회 실패:", error);
      return;
    }
    // profiles는 board_members와 직접 FK가 없어 별도 조회
    const ids = (members || []).map((m) => m.user_id);
    let emailById = {};
    if (ids.length) {
      const { data: profs } = await db
        .from("profiles")
        .select("id, email")
        .in("id", ids);
      (profs || []).forEach((p) => (emailById[p.id] = p.email));
    }
    memberList.innerHTML = "";
    (members || []).forEach((m) => {
      const li = document.createElement("li");
      const email = emailById[m.user_id] || m.user_id.slice(0, 8);
      li.textContent = email + (m.role === "owner" ? " 👑" : "");
      memberList.appendChild(li);
    });
  }

  /* ===================== 참여 모달 ===================== */
  const joinModal = $("join-modal");
  const joinForm = $("join-form");
  const joinCode = $("join-code");
  const joinMessage = $("join-message");

  joinBoardBtn.addEventListener("click", () => {
    joinCode.value = "";
    joinMessage.textContent = "";
    joinMessage.className = "modal-message";
    joinModal.hidden = false;
  });

  joinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = joinCode.value.trim();
    if (!code) return;
    const { data, error } = await db.rpc("join_board_by_code", { p_code: code });
    if (error) {
      joinMessage.textContent = "참여 실패: " + error.message;
      joinMessage.className = "modal-message modal-message--error";
      return;
    }
    boards = await loadBoards();
    renderBoardSelect();
    joinModal.hidden = true;
    await switchBoard(data);
  });

  // 모달 공통 닫기
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest(".modal-backdrop").hidden = true;
    });
  });
  document.querySelectorAll(".modal-backdrop").forEach((bd) => {
    bd.addEventListener("click", (e) => {
      if (e.target === bd) bd.hidden = true;
    });
  });

  /* ===================== 실시간 (Realtime) ===================== */
  function subscribeRealtime(boardId) {
    unsubscribeRealtime();
    channel = db
      .channel("board-" + boardId)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "cards", filter: "board_id=eq." + boardId },
        async () => {
          cards = await fetchCards(boardId);
          render();
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "activity_log", filter: "board_id=eq." + boardId },
        (payload) => {
          if (activityPanel.hidden) return;
          const empty = activityList.querySelector(".activity-empty");
          if (empty) empty.remove();
          activityList.prepend(buildActivityEl(payload.new));
        }
      )
      .subscribe();
  }

  function unsubscribeRealtime() {
    if (channel) {
      db.removeChannel(channel);
      channel = null;
    }
  }

  /* ===================== 유틸 ===================== */
  let toastEl = null;
  function toast(msg, isError) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "app-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.className = "app-toast" + (isError ? " app-toast--error" : "");
    toastEl.style.opacity = "1";
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => (toastEl.style.opacity = "0"), isError ? 7000 : 3000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function readAuthError() {
    const sources = [
      new URLSearchParams(window.location.search),
      new URLSearchParams(window.location.hash.replace(/^#/, "")),
    ];
    for (const p of sources) {
      const err = p.get("error") || p.get("error_code");
      if (err) return p.get("error_description") || err;
    }
    return null;
  }

  /* ===================== 부트스트랩 ===================== */
  async function start(session) {
    showLoggedIn(session);
    // 기본 보드 확보(없으면 생성 + 기존 카드 이관)
    const { data: defaultId, error } = await db.rpc("get_or_create_default_board");
    if (error) {
      console.error("기본 보드 확보 실패:", error);
      toast(
        "DB 설정이 안 된 것 같아요: " + error.message + " — supabase_setup.md §1-B SQL을 실행하세요.",
        true
      );
    }
    boards = await loadBoards();
    currentBoardId = defaultId || (boards[0] && boards[0].id) || null;
    renderBoardSelect();
    if (currentBoardId) await switchBoard(currentBoardId);
    else if (!error) toast("보드를 찾지 못했습니다. DB 설정(§1-B SQL)을 확인하세요.", true);
  }

  db.auth.onAuthStateChange(async (event, session) => {
    console.log("[auth]", event, session ? "session O" : "session X");
    if (event === "INITIAL_SESSION") return;
    if (session) await start(session);
    else {
      unsubscribeRealtime();
      showLoggedOut();
    }
  });

  (async () => {
    const urlError = readAuthError();
    if (urlError) showAuthError("로그인 실패: " + urlError);

    const { data, error } = await db.auth.getSession();
    if (error) console.error("세션 조회 실패:", error);
    if (data.session) {
      if (window.location.search || window.location.hash) {
        history.replaceState(null, "", REDIRECT_URL);
      }
      await start(data.session);
    } else {
      showLoggedOut();
    }
  })();
})();
