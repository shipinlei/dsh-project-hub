/**
 * dsh-project-hub — Web 客户端插件（手写单文件 bundle，无构建链）。
 * 加载方式：宿主 loader 以 `window.__ModuleLoader__.load({ id, factory })` 引入；
 * factory 返回形如 `{ name, inject, apply }` 的 cordis 插件。
 *
 * 本文件只负责「项目工作台」面板 + 侧栏入口：
 *  - 数据读取：slot 注入的 useWorkspaces / useSessions 选择器钩子（不订阅 store、不轮询）
 *  - 元数据 / 规则 / 记忆作用域：走 /dsh-project-hub/api/* HTTP 接口
 *  - 新建 / 打开会话：apply 里取宿主服务，经 slot inject 传进组件
 *
 * 未实现（按设计结论 D8/D10，UI 上不提供入口）：删除项目、跨项目移动会话、内置记忆编辑器。
 */
window.__ModuleLoader__.load({ id: "dsh-project-hub", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;

	var react = require("react");
	var h = react.createElement;

	var NS = "dsh-project-hub";
	var PANEL_ID = "dsh-project-hub";
	var name = NS;
	var inject = ["slots", "locale"];

	var API = "/dsh-project-hub/api/";
	var MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
	var MINUTE = 60 * 1000;
	var HOUR = 60 * MINUTE;
	var DAY = 24 * HOUR;

	/* ── 文案：每项 [中文, English]，两种语言都必须完整 ───── */
	var TEXT = {
		nav: ["项目", "Projects"],
		title: ["项目工作台", "Project workbench"],
		subtitle: ["按工作区组织会话；项目内共享记忆与设定", "Sessions organised by workspace; memory and settings are shared inside a project"],
		refresh: ["刷新", "Refresh"],
		refreshing: ["刷新中…", "Refreshing…"],
		loading: ["正在读取项目…", "Reading projects…"],
		loadFailed: ["读取失败：", "Load failed: "],
		retry: ["重试", "Retry"],
		dismiss: ["关闭", "Dismiss"],
		empty: ["还没有项目。在任意目录开一个新会话后，这里会出现对应的项目。", "No projects yet. Start a session in any folder and the project will appear here."],
		sessions: ["会话", "Sessions"],
		newSession: ["新建会话", "New session"],
		creating: ["正在新建…", "Creating…"],
		settings: ["设置", "Settings"],
		rules: ["项目规则", "Project rules"],
		recentlyActive: ["最近活跃", "last active"],
		justNow: ["刚刚", "just now"],
		minutesAgo: ["分钟前", "minutes ago"],
		hoursAgo: ["小时前", "hours ago"],
		daysAgo: ["天前", "days ago"],
		sessionsEmpty: ["这个项目还没有会话。", "This project has no sessions yet."],
		blankSession: ["新会话（空白）", "New session (blank)"],
		running: ["运行中", "Running"],
		createFailed: ["新建会话失败：", "Could not create session: "],
		openFailed: ["打开会话失败：", "Could not open session: "],
		copyPath: ["点击复制路径", "Click to copy path"],
		copied: ["已复制", "Copied"],
		copyFailed: ["复制失败：", "Copy failed: "],
		badgePreset: ["预设", "preset"],
		badgeModel: ["模型", "model"],
		badgeReasoning: ["推理", "reasoning"],
		memoryScoped: ["项目记忆已按工作区隔离", "Project memory is isolated per workspace"],
		memoryGlobal: ["当前所有会话共用一份全局记忆，项目之间会互相污染", "All sessions currently share one global memory, so projects can pollute each other"],
		memoryGlobalHint: ["启用后每个项目使用独立记忆目录；用户级 USER.md 保持全局。", "Enabling gives every project its own memory directory; the user-level USER.md stays global."],
		memoryEnable: ["启用按项目记忆隔离", "Isolate memory per project"],
		memoryEnabling: ["正在启用…", "Enabling…"],
		memoryDisable: ["改回全局共享", "Share one global memory"],
		memoryDisabling: ["正在切换…", "Switching…"],
		memoryDisableFailed: ["切换失败：", "Switch failed: "],
		memoryUnavailable: ["读不到记忆设置：", "Cannot read memory settings: "],
		memoryNoInfo: ["接口未返回记忆状态", "the API returned no memory state"],
		memoryEnableFailed: ["启用失败：", "Enable failed: "],
		description: ["描述", "Description"],
		descriptionPlaceholder: ["这个项目是做什么的（显示在项目卡片上）", "What this project is for (shown on the project card)"],
		agentPreset: ["Agent preset", "Agent preset"],
		agentPresetPlaceholder: ["standard", "standard"],
		provider: ["Provider", "Provider"],
		providerPlaceholder: ["deepseek-official", "deepseek-official"],
		model: ["Model", "Model"],
		modelPlaceholder: ["deepseek-flash", "deepseek-flash"],
		reasoning: ["推理强度", "Reasoning effort"],
		reasoningDefault: ["默认（不指定）", "Default (unset)"],
		save: ["保存", "Save"],
		saving: ["保存中…", "Saving…"],
		saved: ["已保存", "Saved"],
		saveFailed: ["保存失败：", "Save failed: "],
		ruleProjectRoot: ["项目根", "Project root"],
		ruleScopeGlobal: ["全局", "global"],
		ruleScopeAgents: ["用户 agents", "user agents"],
		ruleScopeProject: ["项目", "project"],
		ruleScopeProjectLocal: ["项目本地叠加", "project-local overlay"],
		ruleScopeOther: ["其他", "other"],
		ruleExists: ["存在", "present"],
		ruleMissing: ["缺失", "missing"],
		ruleLoading: ["正在读取规则…", "Reading rules…"],
		ruleFailed: ["规则读取失败：", "Could not read rules: "],
		ruleEmpty: ["没有候选规则文件。", "No rule files found."]
	};
	var zh = {};
	var en = {};
	Object.keys(TEXT).forEach(function (key) { zh[key] = TEXT[key][0]; en[key] = TEXT[key][1]; });

	function fallbackT(key) { return zh[key] || key; }

	/* ── 小工具 ───────────────────────────────────────────── */
	function messageOf(error) {
		if (error === null || error === undefined) return "未知错误";
		if (typeof error === "string") return error;
		return error.message ? String(error.message) : String(error);
	}

	function toMs(value) {
		if (typeof value === "number" && isFinite(value)) return value;
		if (value instanceof Date) return value.getTime();
		var parsed = typeof value === "string" && value !== "" ? Date.parse(value) : NaN;
		return isNaN(parsed) ? 0 : parsed;
	}

	function pad2(value) { return value < 10 ? "0" + value : String(value); }

	function formatRelative(timestamp, t) {
		if (!timestamp) return "";
		var diff = Date.now() - timestamp;
		if (diff < 0) diff = 0;
		if (diff < MINUTE) return t("justNow");
		if (diff < HOUR) return Math.floor(diff / MINUTE) + " " + t("minutesAgo");
		if (diff < DAY) return Math.floor(diff / HOUR) + " " + t("hoursAgo");
		if (diff < 7 * DAY) return Math.floor(diff / DAY) + " " + t("daysAgo");
		var date = new Date(timestamp);
		return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
	}

	function baseName(filePath) {
		return typeof filePath === "string" && filePath !== "" ? (filePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "") : "";
	}

	function emptyToNull(value) {
		var trimmed = typeof value === "string" ? value.trim() : "";
		return trimmed === "" ? null : trimmed;
	}

	function withKey(map, key, value) { var next = Object.assign({}, map); next[key] = value; return next; }
	function withoutKey(map, key) { var next = Object.assign({}, map); delete next[key]; return next; }

	/* ── HTTP（契约见 docs/接口约定.md） ───────────────────── */
	function apiUrl(path) {
		try {
			var url = new URL(String(path).replace(/^\/+/, ""), document.baseURI);
			// 必须保留 query（/rules?workspaceId=... 依赖它），只丢掉 hash。
			return url.pathname + url.search;
		} catch (error) {
			return path;
		}
	}

	async function request(path, options) {
		var init = Object.assign({ cache: "no-store" }, options || {});
		if (init.body !== undefined && typeof init.body !== "string") {
			init.body = JSON.stringify(init.body);
			init.headers = Object.assign({ "content-type": "application/json" }, init.headers || {});
		}
		var response;
		try {
			response = await fetch(apiUrl(path), init);
		} catch (error) {
			throw new Error("无法连接宿主接口（" + path + "）：" + messageOf(error));
		}
		var data = null;
		var bodyText = "";
		try { bodyText = await response.text(); } catch (error) { bodyText = ""; }
		try { data = JSON.parse(bodyText); } catch (error) { data = null; }
		if (!response.ok || !data || data.ok === false) {
			var reason = data && (data.error || data.message);
			// 错误里带上 status + 路径 + 响应正文，便于定位 401/404 等鉴权问题
			throw new Error("HTTP " + response.status + " " + path + "：" + (reason || bodyText.slice(0, 300) || "无响应内容"));
		}
		return data;
	}

	var api = {
		state: function () { return request(API + "state"); },
		saveProject: function (workspaceId, patch) { return request(API + "project", { method: "POST", body: { workspaceId: workspaceId, patch: patch } }); },
		rules: function (workspaceId) { return request(API + "rules?workspaceId=" + encodeURIComponent(workspaceId)); },
		memoryScope: function (body) { return request(API + "memory-scope", { method: "POST", body: body }); },
		clientReport: function (event, data) { return request(API + "client-report", { method: "POST", body: { event: event, data: data || null } }); }
	};

	/* ── 项目元数据小工具 ─────────────────────────────────── */
	var EMPTY_META = { description: "", agentPreset: null, provider: null, model: null, reasoningEffort: null };

	function makeDraft(meta) {
		return {
			description: meta && meta.description || "",
			agentPreset: meta && meta.agentPreset || "",
			provider: meta && meta.provider || "",
			model: meta && meta.model || "",
			reasoningEffort: meta && meta.reasoningEffort || ""
		};
	}

	function selectWorkspaceItems(state) { return state && state.items; }
	function selectSessionsById(state) { return state && state.byId; }
	function noopSelector() { return undefined; }

	/* ── 样式：只使用 --dsw-alias-* 主题 token ────────────── */
	var S = {
		page: { padding: "28px 32px", maxWidth: 960, margin: "0 auto", height: "100%", overflowY: "auto", boxSizing: "border-box", fontSize: 14, color: "var(--dsw-alias-label-primary)" },
		header: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 18 },
		headerMain: { minWidth: 0, flex: "1 1 320px" },
		headerActions: { display: "flex", alignItems: "center", gap: 10, flex: "0 0 auto" },
		h1: { fontSize: 22, lineHeight: 1.3, fontWeight: 600, margin: "0 0 6px" },
		subtitle: { margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--dsw-alias-label-secondary)" },
		muted: { fontSize: 13, color: "var(--dsw-alias-label-secondary)" },
		mutedInline: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" },
		stateCard: { padding: "26px 20px", textAlign: "center", border: "1px dashed var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-lg)", color: "var(--dsw-alias-label-secondary)" },
		errorText: { fontSize: 12.5, lineHeight: 1.5, color: "var(--dsw-alias-state-error-primary)" },
		errorLine: { marginTop: 8, fontSize: 12.5, color: "var(--dsw-alias-state-error-primary)" },
		okText: { fontSize: 12.5, color: "var(--dsw-alias-brand-primary)" },
		inlineError: { marginBottom: 12, padding: "8px 12px", borderRadius: "var(--dsw-radius-md)", border: "1px solid var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-state-error-primary)", fontSize: 12.5 },
		errorBanner: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 16, padding: "9px 12px", borderRadius: "var(--dsw-radius-md)", border: "1px solid var(--dsw-alias-state-error-primary)", background: "var(--dsw-alias-bg-layer-1)" },
		memoryBar: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 14px", marginBottom: 16, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-bg-layer-1)" },
		memoryOk: { borderLeft: "3px solid var(--dsw-alias-brand-primary)" },
		memoryWarn: { borderLeft: "3px solid var(--dsw-alias-state-error-primary)" },
		memoryMain: { flex: "1 1 320px", minWidth: 0 },
		memoryTitle: { fontSize: 13, fontWeight: 600, marginBottom: 2 },
		memoryActions: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 },
		statusDot: { width: 7, height: 7, flex: "0 0 auto", borderRadius: "50%", background: "var(--dsw-alias-brand-primary)" },
		code: { fontFamily: MONO, fontSize: 11.5, padding: "1px 6px", borderRadius: "var(--dsw-radius-sm)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)" },
		card: { marginBottom: 12, padding: "16px 18px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-lg)", background: "var(--dsw-alias-bg-layer-1)" },
		cardHead: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
		cardMain: { flex: "1 1 320px", minWidth: 0 },
		cardTitleRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 },
		cardTitle: { maxWidth: "100%", fontSize: 15.5, lineHeight: 1.4, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
		cardActions: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, flexWrap: "wrap", flex: "0 1 auto" },
		metaLine: { fontSize: 12.5, color: "var(--dsw-alias-label-tertiary)", marginBottom: 4 },
		badge: { fontFamily: MONO, fontSize: 11, padding: "1px 7px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap" },
		badgeOk: { fontFamily: MONO, fontSize: 11, padding: "1px 7px", borderRadius: 999, border: "1px solid var(--dsw-alias-brand-primary)", color: "var(--dsw-alias-brand-primary)", whiteSpace: "nowrap" },
		pathRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 },
		pathButton: { margin: 0, padding: "1px 4px", border: "none", background: "transparent", color: "var(--dsw-alias-label-secondary)", fontFamily: MONO, fontSize: 11.5, textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" },
		copyOk: { fontSize: 11, color: "var(--dsw-alias-brand-primary)" },
		copyFail: { fontSize: 11, color: "var(--dsw-alias-state-error-primary)" },
		description: { margin: "8px 0 0", fontSize: 13, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-word" },
		subsection: { display: "flex", flexDirection: "column", gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--dsw-alias-border-l1)" },
		sessionRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, width: "100%", padding: "7px 9px", border: "1px solid transparent", borderRadius: "var(--dsw-radius-md)", background: "transparent", color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: 13, textAlign: "left", cursor: "pointer" },
		sessionRowHover: { background: "var(--dsw-alias-interactive-bg-hover)" },
		sessionTitle: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
		sessionMeta: { display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" },
		sessionTime: { fontSize: 11.5, color: "var(--dsw-alias-label-tertiary)" },
		dot: { width: 6, height: 6, flex: "0 0 auto", borderRadius: "50%", background: "var(--dsw-alias-brand-primary)" },
		field: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
		fieldLabel: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
		input: { width: "100%", boxSizing: "border-box", padding: "6px 9px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: 13, outline: "none" },
		textarea: { minHeight: 62, lineHeight: 1.5, resize: "vertical" },
		formGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 },
		formActions: { display: "flex", alignItems: "center", gap: 10 },
		ruleFile: { padding: "8px 10px", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-bg-layer-2)" },
		ruleHead: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
		monoSmall: { fontFamily: MONO, fontSize: 11.5, color: "var(--dsw-alias-label-secondary)", wordBreak: "break-all" },
		rulePath: { fontFamily: MONO, fontSize: 11.5, color: "var(--dsw-alias-label-secondary)", wordBreak: "break-all", overflow: "hidden", textOverflow: "ellipsis" },
		excerpt: { margin: "8px 0 0", padding: "8px 10px", maxHeight: 220, overflow: "auto", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "var(--dsw-radius-sm)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-secondary)", fontFamily: MONO, fontSize: 11.5, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" },
		buttonBase: { display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: 13, lineHeight: 1.4, cursor: "pointer", whiteSpace: "nowrap" },
		buttonSmall: { padding: "3px 9px", fontSize: 12.5 },
		buttonPrimary: { borderColor: "var(--dsw-alias-brand-primary)", color: "var(--dsw-alias-brand-primary)" },
		buttonActive: { borderColor: "var(--dsw-alias-brand-primary)", background: "var(--dsw-alias-bg-module-platform)" },
		buttonHover: { background: "var(--dsw-alias-interactive-bg-hover)" },
		buttonDisabled: { opacity: 0.5, cursor: "default" }
	};

	/* ── 基础小组件 ───────────────────────────────────────── */
	function Button(props) {
		var [hover, setHover] = react.useState(false);
		var style = Object.assign({}, S.buttonBase,
			props.small ? S.buttonSmall : null, props.primary ? S.buttonPrimary : null,
			props.active ? S.buttonActive : null, hover && !props.disabled ? S.buttonHover : null,
			props.disabled ? S.buttonDisabled : null, props.style || null);
		return h("button", {
			type: "button", disabled: Boolean(props.disabled), title: props.title || undefined, style: style,
			onClick: props.disabled ? undefined : props.onClick,
			onMouseEnter: function () { setHover(true); }, onMouseLeave: function () { setHover(false); }
		}, props.children);
	}

	function Field(props) {
		return h("label", { style: S.field }, h("span", { style: S.fieldLabel }, props.label), props.children);
	}

	/* ── 记忆状态条 ───────────────────────────────────────── */
	function MemoryBar(props) {
		var t = props.t;
		var memory = props.memory;
		if (!memory || memory.available === false) {
			var reason = memory ? memory.error || t("memoryNoInfo") : t("memoryNoInfo");
			return h("div", { style: S.memoryBar }, h("span", { style: S.muted }, t("memoryUnavailable") + reason));
		}
		if (memory.projectScoped === true) {
			return h("div", { style: Object.assign({}, S.memoryBar, S.memoryOk) },
				h("span", { style: S.statusDot }),
				h("span", { style: { fontSize: 13 } }, t("memoryScoped")),
				h("code", { style: S.code }, "storageScope = " + (memory.storageScope || "workspaces")),
				h("div", { style: S.memoryActions },
					h(Button, { disabled: Boolean(props.busy), onClick: props.onDisable }, props.busy ? t("memoryDisabling") : t("memoryDisable")),
					props.error ? h("span", { style: S.errorText }, t("memoryDisableFailed") + props.error) : null));
		}
		return h("div", { style: Object.assign({}, S.memoryBar, S.memoryWarn) },
			h("div", { style: S.memoryMain },
				h("div", { style: S.memoryTitle }, t("memoryGlobal")),
				h("div", { style: S.muted }, t("memoryGlobalHint"))),
			h("div", { style: S.memoryActions },
				h(Button, { primary: true, disabled: Boolean(props.busy), onClick: props.onEnable }, props.busy ? t("memoryEnabling") : t("memoryEnable")),
				props.error ? h("span", { style: S.errorText }, t("memoryEnableFailed") + props.error) : null));
	}

	/* ── 会话行 ───────────────────────────────────────────── */
	function SessionRow(props) {
		var [hover, setHover] = react.useState(false);
		var t = props.t;
		var session = props.session || {};
		var title = session.blank ? t("blankSession") : (session.displayTitle || session.title || session.id || "");
		return h("button", {
			type: "button", title: session.id || "",
			style: hover ? Object.assign({}, S.sessionRow, S.sessionRowHover) : S.sessionRow,
			onClick: props.onOpen,
			onMouseEnter: function () { setHover(true); }, onMouseLeave: function () { setHover(false); }
		},
			h("span", { style: S.sessionTitle }, title),
			h("span", { style: S.sessionMeta },
				session.running ? h("span", { style: S.dot, title: t("running") }) : null,
				h("span", { style: S.sessionTime }, formatRelative(toMs(session.updatedAt), t))));
	}

	/* ── 项目默认设置表单 ─────────────────────────────────── */
	function SettingsForm(props) {
		var t = props.t;
		var draft = props.draft || {};
		function change(field) {
			return function (event) {
				var next = Object.assign({}, draft);
				next[field] = event.target.value;
				props.onChange(next);
			};
		}
		function textField(label, field, placeholder) {
			return h(Field, { label: label }, h("input", { style: S.input, value: draft[field] || "", placeholder: placeholder, onChange: change(field) }));
		}
		return h("div", { style: S.subsection },
			h(Field, { label: t("description") },
				h("textarea", { style: Object.assign({}, S.input, S.textarea), value: draft.description || "", placeholder: t("descriptionPlaceholder"), onChange: change("description") })),
			h("div", { style: S.formGrid },
				textField(t("agentPreset"), "agentPreset", t("agentPresetPlaceholder")),
				textField(t("provider"), "provider", t("providerPlaceholder")),
				textField(t("model"), "model", t("modelPlaceholder")),
				h(Field, { label: t("reasoning") },
					h("select", { style: S.input, value: draft.reasoningEffort || "", onChange: change("reasoningEffort") },
						h("option", { value: "" }, t("reasoningDefault")),
						h("option", { value: "high" }, "high"),
						h("option", { value: "medium" }, "medium"),
						h("option", { value: "low" }, "low")))),
			h("div", { style: S.formActions },
				h(Button, { primary: true, disabled: Boolean(props.saving), onClick: props.onSave }, props.saving ? t("saving") : t("save")),
				props.message
					? h("span", { style: props.message.ok ? S.okText : S.errorText },
						props.message.ok ? t("saved") : t("saveFailed") + (props.message.error || ""))
					: null));
	}

	/* ── 项目规则预览（懒加载） ───────────────────────────── */
	function RulesView(props) {
		var t = props.t;
		var state = props.state || {};
		if (state.phase === "error") return h("div", { style: S.subsection }, h("div", { style: S.errorText }, t("ruleFailed") + (state.error || "")));
		if (!state.data || state.phase === "loading") return h("div", { style: S.subsection }, h("div", { style: S.muted }, t("ruleLoading")));
		var files = Array.isArray(state.data.files) ? state.data.files : [];
		var scopeLabels = {
			global: t("ruleScopeGlobal"),
			agents: t("ruleScopeAgents"),
			project: t("ruleScopeProject"),
			"project-local": t("ruleScopeProjectLocal")
		};
		return h("div", { style: S.subsection },
			h("div", { style: S.monoSmall }, t("ruleProjectRoot") + " " + (state.data.projectRoot || "—")),
			files.length === 0
				? h("div", { style: S.muted }, t("ruleEmpty"))
				: files.map(function (file, index) {
					var filePath = file && file.path ? file.path : "";
					return h("div", { key: filePath || String(index), style: S.ruleFile },
						h("div", { style: S.ruleHead },
							h("span", { style: S.rulePath, title: filePath }, filePath),
							h("span", { style: S.badge }, scopeLabels[file && file.scope] || t("ruleScopeOther")),
							h("span", { style: file && file.exists ? S.badgeOk : S.badge }, file && file.exists ? t("ruleExists") : t("ruleMissing"))),
						file && file.exists && file.excerpt ? h("pre", { style: S.excerpt }, file.excerpt) : null);
				}));
	}

	/* ── 项目卡片 ─────────────────────────────────────────── */
	function ProjectCard(props) {
		var t = props.t;
		var workspace = props.workspace || {};
		var workspaceId = workspace.workspaceId;
		var meta = props.meta || EMPTY_META;
		var actions = props.actions || {};
		var expand = props.expand || {};
		var sessions = props.sessions || [];
		var draft = props.draft || makeDraft(meta);
		var title = workspace.title || baseName(workspace.path) || workspaceId || "";
		var activeText = formatRelative(props.activeAt, t);
		var metaLine = t("sessions") + " " + (props.sessionCount || 0)
			+ (activeText ? " · " + t("recentlyActive") + " " + activeText : "");
		var badges = [
			meta.agentPreset ? [t("badgePreset"), meta.agentPreset] : null,
			meta.model ? [t("badgeModel"), meta.model] : null,
			meta.reasoningEffort ? [t("badgeReasoning"), meta.reasoningEffort] : null
		].filter(Boolean);

		return h("section", { style: S.card },
			h("div", { style: S.cardHead },
				h("div", { style: S.cardMain },
					h("div", { style: S.cardTitleRow },
						h("span", { style: S.cardTitle, title: workspace.path || title }, title),
						badges.map(function (badge, index) {
							return h("span", { key: String(index), style: S.badge }, badge[0] + " " + badge[1]);
						})),
					h("div", { style: S.metaLine }, metaLine),
					h("div", { style: S.pathRow },
						h("button", {
							type: "button", style: S.pathButton, title: t("copyPath"),
							onClick: function () { actions.copy(workspaceId, workspace.path); }
						}, workspace.path || ""),
						props.copy
							? h("span", { style: props.copy.ok ? S.copyOk : S.copyFail },
								props.copy.ok ? t("copied") : t("copyFailed") + (props.copy.error || ""))
							: null)),
				h("div", { style: S.cardActions },
					h(Button, { small: true, primary: true, disabled: Boolean(props.creating), onClick: function () { actions.create(workspaceId, meta); } },
						props.creating ? t("creating") : t("newSession")),
					h(Button, { small: true, active: Boolean(expand.sessions), onClick: function () { actions.toggle(workspaceId, "sessions"); } },
						t("sessions") + " (" + (props.sessionCount || 0) + ")"),
					h(Button, { small: true, active: Boolean(expand.settings), onClick: function () { actions.toggle(workspaceId, "settings"); } },
						t("settings")),
					h(Button, { small: true, active: Boolean(expand.rules), onClick: function () { actions.toggle(workspaceId, "rules"); } },
						t("rules")))),
			props.createError ? h("div", { style: S.errorLine }, t("createFailed") + props.createError) : null,
			meta.description ? h("div", { style: S.description }, meta.description) : null,
			expand.sessions
				? h("div", { style: S.subsection },
					sessions.length === 0
						? h("div", { style: S.muted }, t("sessionsEmpty"))
						: sessions.map(function (session) {
							return h(SessionRow, { key: session.id, t: t, session: session, onOpen: function () { actions.openSession(session.id); } });
						}))
				: null,
			expand.settings
				? h(SettingsForm, {
					t: t, draft: draft, saving: Boolean(props.saving), message: props.saveMessage,
					onChange: function (nextDraft) { actions.changeDraft(workspaceId, nextDraft); },
					onSave: function () { actions.save(workspaceId, draft); }
				})
				: null,
			expand.rules ? h(RulesView, { t: t, state: props.rules }) : null);
	}

	/* ── 面板主体 ─────────────────────────────────────────── */
	function ProjectHubPanel(props) {
		var t = typeof props.t === "function" ? props.t : fallbackT;
		var useWorkspaces = typeof props.useWorkspaces === "function" ? props.useWorkspaces : noopSelector;
		var useSessions = typeof props.useSessions === "function" ? props.useSessions : noopSelector;
		var createSessionAction = typeof props.createSession === "function"
			? props.createSession : function () { throw new Error("插件未注入新建会话能力"); };
		var openSessionAction = typeof props.openSession === "function"
			? props.openSession : function () { throw new Error("插件未注入打开会话能力"); };

		var aliveRef = react.useRef(true);
		var reportedRef = react.useRef(false);
		var [query, setQuery] = react.useState({ phase: "loading", data: null, error: null, busy: false });
		var [rulesByWid, setRulesByWid] = react.useState({});
		var [expandByWid, setExpandByWid] = react.useState({});
		var [draftsByWid, setDraftsByWid] = react.useState({});
		var [creatingByWid, setCreatingByWid] = react.useState({});
		var [savingByWid, setSavingByWid] = react.useState({});
		var [saveMsgByWid, setSaveMsgByWid] = react.useState({});
		var [createErrorByWid, setCreateErrorByWid] = react.useState({});
		var [memBusy, setMemBusy] = react.useState(false);
		var [memError, setMemError] = react.useState(null);
		var [copyState, setCopyState] = react.useState(null);
		var [errorBanner, setErrorBanner] = react.useState(null);

		// 宿主注入的 standardProps 选择器钩子；缺失时降级为空数据（不崩溃）
		var workspaces = useWorkspaces(selectWorkspaceItems) || [];
		var sessionsById = useSessions(selectSessionsById) || {};

		react.useEffect(function () {
			aliveRef.current = true;
			return function () { aliveRef.current = false; };
		}, []);
		react.useEffect(function () { load(); }, []);

		function put(setter, key, value) { setter(function (prev) { return withKey(prev, key, value); }); }
		// 复制反馈 1.8s 后自动消失
		function showCopy(workspaceId, ok, error) {
			if (!aliveRef.current) return;
			setCopyState({ workspaceId: workspaceId, ok: ok, error: error || null });
			setTimeout(function () { if (aliveRef.current) setCopyState(null); }, 1800);
		}

		async function load() {
			setQuery(function (prev) { return { phase: prev.data ? "ready" : "loading", data: prev.data, error: null, busy: true }; });
			try {
				var data = await api.state();
				if (!aliveRef.current) return;
				setQuery({ phase: "ready", data: data, error: null, busy: false });
				// 首次成功渲染后上报一次，便于宿主侧诊断接口确认面板确实工作（失败不影响 UI）。
				if (!reportedRef.current && typeof props.report === "function") {
					reportedRef.current = true;
					props.report("panel-view", {
						workspaces: workspaces.length,
						sessions: Object.keys(sessionsById || {}).length,
						memoryScoped: !!(data && data.memory && data.memory.projectScoped),
						services: props.servicesReady || null
					});
				}
			} catch (error) {
				if (!aliveRef.current) return;
				setQuery(function (prev) {
					return { phase: prev.data ? "ready" : "error", data: prev.data, error: messageOf(error), busy: false };
				});
			}
		}

		async function loadRules(workspaceId) {
			put(setRulesByWid, workspaceId, { phase: "loading", data: null, error: null });
			try {
				var data = await api.rules(workspaceId);
				if (aliveRef.current) put(setRulesByWid, workspaceId, { phase: "ready", data: data, error: null });
			} catch (error) {
				if (aliveRef.current) put(setRulesByWid, workspaceId, { phase: "error", data: null, error: messageOf(error) });
			}
		}

		function toggle(workspaceId, key) {
			var willOpen = !(expandByWid[workspaceId] || {})[key];
			setExpandByWid(function (prev) {
				var nextState = Object.assign({}, prev[workspaceId] || {});
				nextState[key] = willOpen;
				return withKey(prev, workspaceId, nextState);
			});
			if (key === "rules" && willOpen) {
				var cached = rulesByWid[workspaceId];
				if (!cached || cached.phase === "error") loadRules(workspaceId);
			}
		}

		async function saveSettings(workspaceId, draft) {
			var patch = {
				description: emptyToNull(draft.description),
				agentPreset: emptyToNull(draft.agentPreset),
				provider: emptyToNull(draft.provider),
				model: emptyToNull(draft.model),
				reasoningEffort: emptyToNull(draft.reasoningEffort)
			};
			put(setSavingByWid, workspaceId, true);
			put(setSaveMsgByWid, workspaceId, null);
			try {
				await api.saveProject(workspaceId, patch);
				if (!aliveRef.current) return;
				setDraftsByWid(function (prev) { return withoutKey(prev, workspaceId); });
				put(setSaveMsgByWid, workspaceId, { ok: true });
				await load();
			} catch (error) {
				if (aliveRef.current) put(setSaveMsgByWid, workspaceId, { ok: false, error: messageOf(error) });
			} finally {
				if (aliveRef.current) put(setSavingByWid, workspaceId, false);
			}
		}

		async function createIn(workspaceId, meta) {
			put(setCreatingByWid, workspaceId, true);
			put(setCreateErrorByWid, workspaceId, null);
			try {
				await createSessionAction(workspaceId, meta || EMPTY_META);
			} catch (error) {
				if (aliveRef.current) put(setCreateErrorByWid, workspaceId, messageOf(error));
			} finally {
				if (aliveRef.current) put(setCreatingByWid, workspaceId, false);
			}
		}

		function openSession(sessionId) {
			try {
				openSessionAction(sessionId);
			} catch (error) {
				if (aliveRef.current) setErrorBanner(t("openFailed") + messageOf(error));
			}
		}

		function copyPath(workspaceId, text) {
			var clipboard = typeof navigator !== "undefined" && navigator ? navigator.clipboard : null;
			if (!clipboard || typeof clipboard.writeText !== "function") {
				showCopy(workspaceId, false, "浏览器未提供剪贴板接口");
				return;
			}
			try {
				var pending = clipboard.writeText(typeof text === "string" ? text : "");
				if (pending && typeof pending.then === "function") {
					pending.then(function () { showCopy(workspaceId, true); }, function (error) { showCopy(workspaceId, false, messageOf(error)); });
				} else {
					showCopy(workspaceId, true);
				}
			} catch (error) {
				showCopy(workspaceId, false, messageOf(error));
			}
		}

		async function enableProjectMemory() {
			setMemBusy(true);
			setMemError(null);
			try {
				await api.memoryScope({ storageScope: "workspaces", runtimeUserScope: "global" });
				if (aliveRef.current) await load();
			} catch (error) {
				if (aliveRef.current) setMemError(messageOf(error));
			} finally {
				if (aliveRef.current) setMemBusy(false);
			}
		}

		// 回滚：恢复为全局共享一份记忆（与「启用」同一接口，user 级 USER.md 作用域回 storage）。
		async function disableProjectMemory() {
			setMemBusy(true);
			setMemError(null);
			try {
				await api.memoryScope({ storageScope: "global" });
				if (aliveRef.current) await load();
			} catch (error) {
				if (aliveRef.current) setMemError(messageOf(error));
			} finally {
				if (aliveRef.current) setMemBusy(false);
			}
		}

		// 工作区 + 项目元数据合成卡片数据，按最近活跃倒序
		var stateData = query.data;
		var projectsMeta = (stateData && stateData.projects) || {};
		var items = [];
		for (var index = 0; index < workspaces.length; index++) {
			var workspace = workspaces[index] || {};
			var workspaceId = workspace.workspaceId;
			if (!workspaceId) continue;
			var sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
			var rows = [];
			for (var sessionIndex = 0; sessionIndex < sessionIds.length; sessionIndex++) {
				if (sessionsById[sessionIds[sessionIndex]]) rows.push(sessionsById[sessionIds[sessionIndex]]);
			}
			rows.sort(function (a, b) { return toMs(b.updatedAt) - toMs(a.updatedAt); });
			var activeAt = 0;
			for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
				var sessionMs = toMs(rows[rowIndex].updatedAt);
				if (sessionMs > activeAt) activeAt = sessionMs;
			}
			if (!activeAt) activeAt = toMs(workspace.updatedAt);
			items.push({
				workspace: workspace,
				meta: projectsMeta[workspaceId] || EMPTY_META,
				rows: rows,
				sessionCount: sessionIds.length,
				activeAt: activeAt
			});
		}
		items.sort(function (a, b) { return b.activeAt - a.activeAt; });

		var actions = {
			toggle: toggle, copy: copyPath, save: saveSettings, create: createIn, openSession: openSession,
			changeDraft: function (workspaceId, draft) { put(setDraftsByWid, workspaceId, draft); }
		};

		var body;
		if (!stateData) {
			body = query.phase === "error"
				? h("div", { style: S.stateCard },
					h("div", { style: S.errorText }, t("loadFailed") + (query.error || "")),
					h("div", { style: { marginTop: 10 } }, h(Button, { onClick: function () { load(); } }, t("retry"))))
				: h("div", { style: S.stateCard }, h("span", { style: S.muted }, t("loading")));
		} else if (items.length === 0) {
			body = h("div", { style: S.stateCard }, h("span", { style: S.muted }, t("empty")));
		} else {
			body = items.map(function (item) {
				var workspaceId = item.workspace.workspaceId;
				return h(ProjectCard, {
					key: workspaceId, t: t, workspace: item.workspace, meta: item.meta, sessions: item.rows,
					sessionCount: item.sessionCount, activeAt: item.activeAt,
					expand: expandByWid[workspaceId], draft: draftsByWid[workspaceId], rules: rulesByWid[workspaceId],
					creating: Boolean(creatingByWid[workspaceId]), saving: Boolean(savingByWid[workspaceId]),
					saveMessage: saveMsgByWid[workspaceId] || null, createError: createErrorByWid[workspaceId] || null,
					copy: copyState && copyState.workspaceId === workspaceId ? copyState : null, actions: actions
				});
			});
		}

		return h("div", { style: S.page },
			h("div", { style: S.header },
				h("div", { style: S.headerMain },
					h("h1", { style: S.h1 }, t("title")),
					h("p", { style: S.subtitle }, t("subtitle"))),
				h("div", { style: S.headerActions },
					query.busy ? h("span", { style: S.mutedInline }, t("refreshing")) : null,
					h(Button, { onClick: function () { load(); }, disabled: Boolean(query.busy) }, t("refresh")))),
			stateData
				? h(MemoryBar, { t: t, memory: stateData.memory, busy: memBusy, error: memError, onEnable: enableProjectMemory, onDisable: disableProjectMemory })
				: null,
			errorBanner
				? h("div", { style: S.errorBanner },
					h("span", { style: S.errorText }, errorBanner),
					h(Button, { small: true, onClick: function () { setErrorBanner(null); } }, t("dismiss")))
				: null,
			stateData && query.error ? h("div", { style: S.inlineError }, t("loadFailed") + query.error) : null,
			body);
	}

	/** 侧栏图标：文件夹轮廓（16px，跟随 currentColor）。 */
	function FolderIcon(owner) {
		var size = owner && owner.size ? owner.size : 16;
		return react.createElement("svg", {
			width: size,
			height: size,
			viewBox: "0 0 16 16",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.4,
			strokeLinejoin: "round",
			"aria-hidden": "true"
		}, react.createElement("path", {
			d: "M1.75 4.25c0-.55.45-1 1-1h3.1c.33 0 .64.16.83.43l.67.95h5.9c.55 0 1 .45 1 1v6.12c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z"
		}));
	}

	/* ── 插件装配 ─────────────────────────────────────────── */
	function apply(ctx) {
		ctx.effect(function () { ctx.locale.register(NS, { zh: zh, en: en }); }, NS + ": locale dictionaries");
		var t = ctx.locale.bind(NS);

		// 宿主服务：优先 ctx.inject 注入，其次按需 ctx.get（缺失时组件显式报错）
		var services = { sessions: null, uiWorkspace: null };
		try {
			ctx.inject(["sessions", "uiWorkspace"], function (scoped) {
				services.sessions = scoped.sessions || null;
				services.uiWorkspace = scoped.uiWorkspace || null;
			});
		} catch (error) {
			console.warn("[dsh-project-hub] 注入 sessions/uiWorkspace 失败", error);
		}

		var layout = null;
		try {
			ctx.inject(["layout"], function (scoped) { layout = scoped.layout; });
		} catch (error) {
			/* 布局服务缺失时忽略：只影响卸载时重置面板 */
		}

		function readService(serviceName) {
			if (services[serviceName]) return services[serviceName];
			try {
				if (typeof ctx.get === "function") {
					var found = ctx.get(serviceName);
					if (found) return found;
				}
			} catch (error) {
				/* 服务缺失，交给调用方给出可读错误 */
			}
			return null;
		}

		// 新建会话：create → 套默认模型 → 打开；每一步失败都抛可读错误交面板显示
		async function createSession(workspaceId, defaults) {
			var sessions = readService("sessions");
			if (!sessions || typeof sessions.create !== "function") throw new Error("当前宿主未提供会话服务（sessions），无法新建会话");
			var preset = defaults && typeof defaults.agentPreset === "string" ? defaults.agentPreset.trim() : "";
			var createArgs = { workspaceId: workspaceId };
			if (preset) createArgs.agentPreset = preset;
			var sessionId = await sessions.create(createArgs);
			if (!sessionId || typeof sessionId !== "string") throw new Error("新建会话失败：会话服务未返回会话 id");
			var provider = defaults && defaults.provider;
			var model = defaults && defaults.model;
			if (provider && model) {
				// 客户端没有 sessions.selectModel；官方模型选择走 Remote 命名空间 ctx.remote.session.selectModel。
				var remote = readService("remote");
				var wire = remote && remote.session;
				if (!wire || typeof wire.selectModel !== "function") {
					throw new Error("当前宿主未提供模型选择接口（remote.session.selectModel），无法套用项目默认模型（会话已创建，可在展开的会话列表中打开）");
				}
				try {
					var selection = { sessionId: sessionId, provider: provider, model: model };
					if (defaults.reasoningEffort) selection.reasoningEffort = defaults.reasoningEffort;
					var result = await wire.selectModel(selection);
					if (result && result.ok === false) {
						throw new Error((result.error && (result.error.code + ": " + result.error.message)) || "模型选择被宿主拒绝");
					}
				} catch (error) {
					throw new Error("项目默认模型应用失败：" + messageOf(error) + "（会话已创建，可在展开的会话列表中打开）");
				}
			}
			var uiWorkspace = readService("uiWorkspace");
			if (!uiWorkspace || typeof uiWorkspace.openSession !== "function") throw new Error("当前宿主未提供界面导航服务（uiWorkspace），无法打开新会话");
			uiWorkspace.openSession(sessionId);
			return sessionId;
		}

		function openSession(sessionId) {
			var uiWorkspace = readService("uiWorkspace");
			if (!uiWorkspace || typeof uiWorkspace.openSession !== "function") throw new Error("当前宿主未提供界面导航服务（uiWorkspace），无法打开会话");
			uiWorkspace.openSession(sessionId);
		}

		// 诊断上报：把“渲染器已加载/面板已渲染”写进宿主日志，供 /health 查看；失败静默。
		function reportClient(event, data) {
			try {
				var pending = api.clientReport(event, data);
				if (pending && typeof pending.catch === "function") pending.catch(function () {});
			} catch (error) {
				/* 诊断上报失败不影响面板 */
			}
		}

		function servicesReady() {
			var remote = readService("remote");
			return {
				sessions: !!readService("sessions"),
				uiWorkspace: !!readService("uiWorkspace"),
				layout: !!layout,
				modelSelection: !!(remote && remote.session && typeof remote.session.selectModel === "function")
			};
		}

		ctx.slots.inject("main", function () {
			return ctx.slots.inject("sidebar.panellist", function () {
				var disposePanel = ctx.slots.register({
					name: "main", key: PANEL_ID, locale: NS,
					inject: function () {
						return {
							t: t,
							createSession: createSession,
							openSession: openSession,
							report: reportClient,
							servicesReady: servicesReady()
						};
					}
				}, ProjectHubPanel);

				var disposeRow = ctx.slots.register({
					name: "sidebar.panellist", id: PANEL_ID, order: 4, locale: NS,
					label: function () { return t("nav"); }
				}, function (owner) { return h(FolderIcon, owner || {}); });

				console.warn("[dsh-project-hub] client mounted (panel + sidebar entry)");
				reportClient("mounted", { panelId: PANEL_ID, services: servicesReady() });

				return function () {
					try {
						if (layout && layout.panelInfo && layout.panelInfo.getSnapshot().activePanelId === PANEL_ID) layout.selectPanel(null);
					} catch (error) {
						/* 布局不支持时忽略 */
					}
					if (typeof disposeRow === "function") disposeRow();
					if (typeof disposePanel === "function") disposePanel();
				};
			});
		});
	}

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
}});
