// 临时交互冒烟测试：stub 掉 window/react/fetch，模拟多次渲染来跑真实 UI 流程。
import fs from "node:fs";
import assert from "node:assert";

const file = process.argv[2];
const code = fs.readFileSync(file, "utf8");

// ── 迷你 React hooks 运行时（只为首组件树保留 state）────────
let currentScope = null;
let rootScope = null;

const react = {
	createElement(type, props) {
		const children = Array.prototype.slice.call(arguments, 2);
		if (typeof type === "function") {
			const prev = currentScope;
			currentScope = { i: 0, values: {}, refs: {}, effectStore: {}, pending: [], dirty: false };
			try {
				return type(Object.assign({}, props || {}, { children: children.length === 1 ? children[0] : children }));
			} finally {
				currentScope = prev;
			}
		}
		return { type: type, props: props || {}, children: children };
	},
	useState(initial) {
		const scope = currentScope;
		if (!scope) return [initial, function () {}];
		const index = scope.i++;
		if (!(index in scope.values)) scope.values[index] = typeof initial === "function" ? initial() : initial;
		return [scope.values[index], function setter(value) {
			scope.values[index] = typeof value === "function" ? value(scope.values[index]) : value;
			scope.dirty = true;
		}];
	},
	useRef(initial) {
		const scope = currentScope;
		if (!scope) return { current: initial };
		const index = scope.i++;
		if (!(index in scope.refs)) scope.refs[index] = { current: initial };
		return scope.refs[index];
	},
	useEffect(fn, deps) {
		const scope = currentScope;
		if (!scope) return;
		const index = scope.i++;
		const prev = scope.effectStore[index];
		const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some(function (dep, i) { return dep !== prev.deps[i]; });
		if (!changed) return;
		if (prev && typeof prev.cleanup === "function") { try { prev.cleanup(); } catch {} }
		scope.effectStore[index] = { deps: deps || null };
		scope.pending.push({ index: index, fn: fn });
	}
};

globalThis.window = { __ModuleLoader__: { load(opts) { globalThis.__captured = opts; } } };
globalThis.document = { baseURI: "http://127.0.0.1:2586/" };
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async function () {} } }, configurable: true });

const loader = globalThis.__captured;
new Function("window", "document", "require", code)(globalThis.window, globalThis.document, function requireStub(name) {
	if (name === "react") return react;
	throw new Error("unexpected require: " + name);
});
const mod = globalThis.__captured.factory(function requireStub(name) {
	if (name === "react") return react;
	throw new Error("unexpected require: " + name);
});

// ── 文案 ───────────────────────────────────────────────
const dictionaries = {};
function fakeT(key) { return (dictionaries["dsh-project-hub"] && dictionaries["dsh-project-hub"].zh[key]) || key; }

// ── 树工具 ─────────────────────────────────────────────
function textOf(node) {
	if (node === null || node === undefined) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (typeof node === "object") return textOf(node.children);
	return "";
}

function findNodes(node, pred, out) {
	out = out || [];
	if (node === null || node === undefined || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		node.forEach(function (child) { findNodes(child, pred, out); });
		return out;
	}
	if (pred(node)) out.push(node);
	findNodes(node.children, pred, out);
	return out;
}

function buttonsByText(tree, text) {
	return findNodes(tree, function (node) {
		return node.type === "button" && textOf(node).indexOf(text) !== -1;
	});
}

function buttonByText(tree, text) {
	const hits = buttonsByText(tree, text);
	assert.ok(hits.length > 0, "找不到按钮：" + text + "；当前按钮：" + findNodes(tree, function (n) { return n.type === "button"; }).map(function (n) { return textOf(n).trim(); }).join(" / "));
	return hits[0];
}

// ── 渲染/结算 ──────────────────────────────────────────
function makeRenderer(panelComp, props) {
	rootScope = { i: 0, values: {}, refs: {}, effectStore: {}, pending: [], dirty: false };
	return {
		async settle(rounds) {
			rounds = rounds || 8;
			let tree;
			for (let round = 0; round < rounds; round++) {
				rootScope.i = 0;
				rootScope.dirty = false;
				rootScope.pending = [];
				currentScope = rootScope;
				try { tree = panelComp(props); } finally { currentScope = null; }
				const pending = rootScope.pending;
				rootScope.pending = [];
				pending.forEach(function (item) {
					const cleanup = item.fn();
					if (typeof cleanup === "function") rootScope.effectStore[item.index].cleanup = cleanup;
				});
				await new Promise(function (resolve) { setTimeout(resolve, 3); });
				if (!rootScope.dirty) return tree;
			}
			return tree;
		}
	};
}

// ── 假 fetch（按路径路由）──────────────────────────────
const fetchLog = [];
let scenario = null;

async function fakeFetch(path, init) {
	const method = (init && init.method) || "GET";
	const body = init && typeof init.body === "string" ? JSON.parse(init.body) : null;
	fetchLog.push({ method: method, path: path, body: body });
	const handler = scenario && scenario[method + " " + path.split("?")[0]];
	if (!handler) throw new Error("unexpected fetch: " + method + " " + path);
	return handler(body, path);
}

function jsonResponse(status, payload) {
	return { ok: status >= 200 && status < 300, status: status, async text() { return JSON.stringify(payload); } };
}

globalThis.fetch = fakeFetch;

// ── 公共 fixture ───────────────────────────────────────
const NOW = Date.now();
const workspaces = [
	{ workspaceId: "ws-alpha", path: "D:\\projects\\alpha", title: "订单对账系统", sessionIds: ["s1", "s2"], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z" },
	{ workspaceId: "ws-beta", path: "D:\\projects\\beta", title: "项目组开发插件", sessionIds: ["s3"], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z" }
];
const sessionsById = {
	s1: { id: "s1", displayTitle: "实现对账导入", running: true, blank: false, updatedAt: NOW - 5 * 60 * 1000 },
	s2: { id: "s2", displayTitle: "", blank: true, updatedAt: NOW - 2 * 60 * 60 * 1000 },
	s3: { id: "s3", displayTitle: "客户端插件", running: false, blank: false, updatedAt: NOW - 3 * 24 * 60 * 60 * 1000 }
};

function makeState(memory) {
	return {
		ok: true, version: 1, profileDir: "C:/fake-profile",
		projects: {
			"ws-alpha": { description: "订单对账系统", agentPreset: "standard", provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high", updatedAt: "2026-11-10T07:00:00.000Z" },
			"ws-beta": { description: "", agentPreset: null, provider: null, model: null, reasoningEffort: null, updatedAt: "2026-11-09T07:00:00.000Z" }
		},
		memory: memory || { available: true, namespace: "mnemon", storageScope: "global", runtimeUserScope: "storage", projectScoped: false, error: null }
	};
}

const rulesPayload = {
	ok: true,
	projectRoot: "D:\\projects\\alpha",
	files: [
		{ path: "C:\\Users\\x\\.dsh\\AGENTS.md", scope: "global", exists: false, size: 0, excerpt: null },
		{ path: "C:\\Users\\x\\.agents\\AGENTS.md", scope: "agents", exists: true, size: 100, excerpt: "用户级规则" },
		{ path: "D:\\projects\\alpha\\AGENTS.md", scope: "project", exists: true, size: 812, excerpt: "项目规则正文" },
		{ path: "D:\\projects\\alpha\\AGENTS.local.md", scope: "project-local", exists: false, size: 0, excerpt: null }
	]
};

function buildCtx() {
	const calls = [];
	let panelDef = null;
	let panelComp = null;
	let rowDef = null;
	const serviceTable = {
		sessions: {
			async create(args) { calls.push({ kind: "create", args: args }); return "sess-new"; }
		},
		// 客户端模型选择走 Remote 命名空间（官方 ui-model-selection 即 ctx.remote.session.selectModel）
		remote: {
			session: {
				async selectModel(args) { calls.push({ kind: "selectModel", args: args }); return { ok: true, value: undefined }; }
			}
		},
		uiWorkspace: { openSession(id) { calls.push({ kind: "openSession", id: id }); } }
	};
	const ctx = {
		effect(fn) { fn(); },
		locale: {
			register(ns, dicts) { dictionaries[ns] = dicts; },
			bind() { return fakeT; }
		},
		inject(deps, cb) {
			const scoped = {};
			deps.forEach(function (dep) { scoped[dep] = serviceTable[dep]; });
			cb(scoped);
		},
		get(name) { return serviceTable[name] || null; },
		slots: {
			inject(name, cb) { return cb(); },
			register(def, comp) {
				if (def.name === "main") { panelDef = def; panelComp = comp; }
				else rowDef = def;
				return function () {};
			}
		}
	};
	return { ctx: ctx, calls: calls, getPanel: function () { return { def: panelDef, comp: panelComp, row: rowDef }; } };
}

function panelProps(panelDef) {
	return {
		t: fakeT,
		useWorkspaces: function (selector) { return selector({ items: workspaces }); },
		useSessions: function (selector) { return selector({ byId: sessionsById, ids: Object.keys(sessionsById) }); },
		createSession: panelDef.inject().createSession,
		openSession: panelDef.inject().openSession
	};
}

// ═══ 场景 1：正常流程 ═══════════════════════════════════
{
	let memory = { available: true, namespace: "mnemon", storageScope: "global", runtimeUserScope: "storage", projectScoped: false, error: null };
	scenario = {
		"GET /dsh-project-hub/api/state": async function () { return jsonResponse(200, makeState(memory)); },
		"POST /dsh-project-hub/api/project": async function (body) {
			const project = Object.assign({}, makeState().projects[body.workspaceId], body.patch);
			return jsonResponse(200, { ok: true, workspaceId: body.workspaceId, project: project });
		},
		"GET /dsh-project-hub/api/rules": async function () { return jsonResponse(200, rulesPayload); },
		"POST /dsh-project-hub/api/memory-scope": async function (body) {
			assert.deepStrictEqual(body, { storageScope: "workspaces", runtimeUserScope: "global" });
			memory = { available: true, namespace: "mnemon", storageScope: "workspaces", runtimeUserScope: "global", projectScoped: true, error: null };
			return jsonResponse(200, { ok: true, memory: memory });
		}
	};

	const built = buildCtx();
	mod.apply(built.ctx);
	const panelDef = built.getPanel().def;
	const renderer = makeRenderer(built.getPanel().comp, panelProps(panelDef));

	let tree = await renderer.settle();
	let allText = textOf(tree);

	// 头 + 记忆警示 + 两张卡片
	assert.ok(allText.includes("项目工作台"), "标题");
	assert.ok(allText.includes("当前所有会话共用一份全局记忆"), "应显示全局记忆警示");
	assert.ok(allText.includes("订单对账系统") && allText.includes("项目组开发插件"), "应列出两个真实项目");
	assert.ok(allText.includes("预设 standard") && allText.includes("模型 deepseek-flash") && allText.includes("推理 high"), "应显示项目默认设置徽标");
	assert.ok(allText.includes("· 最近活跃 5 分钟前"), "应显示最近活跃时间");
	assert.ok(allText.includes("D:\\projects\\alpha"), "应显示路径");
	assert.ok(allText.includes("订单对账系统"), "应显示描述");
	assert.strictEqual(built.calls.length, 0, "首屏不应触发会话动作");

	// 展开会话：按 updatedAt 倒序；blank 显示「新会话（空白）」
	const sessionsButton = buttonsByText(tree, "会话 (2)")[0];
	assert.ok(sessionsButton, "应有「会话 (2)」按钮");
	await sessionsButton.props.onClick();
	tree = await renderer.settle();
	const rowButtons = findNodes(tree, function (n) {
		return n.type === "button" && (n.props.title === "s1" || n.props.title === "s2");
	});
	assert.deepStrictEqual(rowButtons.map(function (n) { return n.props.title; }), ["s1", "s2"], "会话应按 updatedAt 倒序");
	assert.ok(textOf(tree).includes("新会话（空白）"), "blank 会话显示为空标题文案");
	assert.ok(findNodes(tree, function (n) { return n.type === "span" && n.props.title === "运行中"; }).length === 1, "running 会话应有小圆点");

	// 点击会话 → openSession
	await rowButtons[0].props.onClick();
	assert.deepStrictEqual(built.calls[built.calls.length - 1], { kind: "openSession", id: "s1" }, "点击会话应打开会话");

	// 展开设置 → 表单预填 → 修改并保存
	const settingsButton = buttonsByText(tree, "设置")[0];
	await settingsButton.props.onClick();
	tree = await renderer.settle();
	const textarea = findNodes(tree, function (n) { return n.type === "textarea"; })[0];
	assert.ok(textarea, "设置应有描述 textarea");
	assert.strictEqual(textarea.props.value, "订单对账系统", "描述应预填项目元数据");
	const presetInput = findNodes(tree, function (n) { return n.type === "input" && n.props.placeholder === "standard"; })[0];
	assert.ok(presetInput && presetInput.props.value === "standard", "agentPreset 输入框应预填");
	const select = findNodes(tree, function (n) { return n.type === "select"; })[0];
	assert.strictEqual(select.props.value, "high", "推理强度应预填 high");
	textarea.props.onChange({ target: { value: "更详细的描述" } });
	tree = await renderer.settle();
	await buttonByText(tree, "保存").props.onClick();
	tree = await renderer.settle();
	const savedPost = fetchLog.filter(function (entry) { return entry.method === "POST" && entry.path === "/dsh-project-hub/api/project"; }).pop();
	assert.deepStrictEqual(savedPost.body, {
		workspaceId: "ws-alpha",
		patch: { description: "更详细的描述", agentPreset: "standard", provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" }
	}, "保存应 POST 正确 patch");
	assert.ok(findNodes(tree, function (n) { return n.type === "span" && textOf(n).includes("已保存"); }).length === 1, "保存后应显示「已保存」");

	// 展开项目规则：懒加载 + scope 中文标签 + excerpt
	tree = await renderer.settle();
	await buttonsByText(tree, "项目规则")[0].props.onClick();
	tree = await renderer.settle();
	const rulesText = textOf(tree);
	assert.ok(rulesText.includes("项目根 D:\\projects\\alpha"), "应显示 projectRoot");
	assert.ok(rulesText.includes("用户 agents") && rulesText.includes("项目本地叠加"), "scope 应显示中文标签");
	assert.ok(!rulesText.includes("project-local"), "不应显示英文 scope");
	assert.ok(rulesText.includes("存在") && rulesText.includes("缺失"), "应显示存在/缺失徽标");
	assert.ok(rulesText.includes("项目规则正文"), "应显示 excerpt");

	// 启用按项目记忆隔离
	await buttonByText(tree, "启用按项目记忆隔离").props.onClick();
	tree = await renderer.settle();
	assert.ok(textOf(tree).includes("项目记忆已按工作区隔离"), "启用后应显示已隔离状态");

	// 新建会话：套用项目默认设置
	tree = await renderer.settle();
	await buttonByText(tree, "新建会话").props.onClick();
	await renderer.settle();
	const createCall = built.calls.filter(function (call) { return call.kind === "create"; }).pop();
	assert.deepStrictEqual(createCall.args, { workspaceId: "ws-alpha", agentPreset: "standard" }, "create 应带 workspaceId + agentPreset");
	const modelCall = built.calls.filter(function (call) { return call.kind === "selectModel"; }).pop();
	assert.deepStrictEqual(modelCall.args, { sessionId: "sess-new", provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" }, "应套用项目默认模型");
	assert.deepStrictEqual(built.calls[built.calls.length - 1], { kind: "openSession", id: "sess-new" }, "最后应打开新会话");
}

// ═══ 场景 2：/state 401 → 错误可读 + 重试 ══════════════
{
	let fail = true;
	scenario = {
		"GET /dsh-project-hub/api/state": async function () {
			if (fail) return jsonResponse(401, { ok: false, error: "unauthorized" });
			return jsonResponse(200, makeState());
		},
		"POST /dsh-project-hub/api/project": async function () { return jsonResponse(200, { ok: true }); },
		"GET /dsh-project-hub/api/rules": async function () { return jsonResponse(404, { ok: false, error: "未知 workspaceId" }); },
		"POST /dsh-project-hub/api/memory-scope": async function () { return jsonResponse(501, { ok: false, error: "no settings" }); }
	};
	const built = buildCtx();
	mod.apply(built.ctx);
	const panelDef = built.getPanel().def;
	const renderer = makeRenderer(built.getPanel().comp, panelProps(panelDef));
	let tree = await renderer.settle();
	let text = textOf(tree);
	assert.ok(text.includes("读取失败：HTTP 401"), "应显示 HTTP status：" + text.slice(0, 200));
	assert.ok(text.includes("unauthorized"), "应显示响应 body 原因");

	fail = false;
	await buttonByText(tree, "重试").props.onClick();
	tree = await renderer.settle();
	assert.ok(textOf(tree).includes("订单对账系统"), "重试成功后应显示项目卡片");

	// rules 404 错误显示
	tree = await renderer.settle();
	await buttonsByText(tree, "项目规则")[0].props.onClick();
	tree = await renderer.settle();
	assert.ok(textOf(tree).includes("规则读取失败：HTTP 404"), "rules 404 应显示可读错误");

	// memory 501 错误显示
	tree = await renderer.settle();
	await buttonByText(tree, "启用按项目记忆隔离").props.onClick();
	tree = await renderer.settle();
	assert.ok(textOf(tree).includes("启用失败：HTTP 501"), "memory 501 应显示可读错误");
}

// ═══ 场景 3：记忆不可读 + 项目作用域已开启 ═════════════
{
	let memory = { available: false, namespace: "mnemon", storageScope: null, runtimeUserScope: null, projectScoped: false, error: "settings 服务不可用" };
	scenario = {
		"GET /dsh-project-hub/api/state": async function () { return jsonResponse(200, makeState(memory)); },
		"POST /dsh-project-hub/api/project": async function () { return jsonResponse(200, { ok: true }); },
		"GET /dsh-project-hub/api/rules": async function () { return jsonResponse(200, rulesPayload); },
		"POST /dsh-project-hub/api/memory-scope": async function () { return jsonResponse(200, { ok: true }); }
	};
	const built = buildCtx();
	mod.apply(built.ctx);
	const panelDef = built.getPanel().def;
	const renderer = makeRenderer(built.getPanel().comp, panelProps(panelDef));
	let tree = await renderer.settle();
	assert.ok(textOf(tree).includes("读不到记忆设置：settings 服务不可用"), "不可读记忆应显示灰字原因");
	assert.strictEqual(buttonsByText(tree, "启用按项目记忆隔离").length, 0, "不可读时不应给启用按钮");

	memory = { available: true, namespace: "mnemon", storageScope: "workspaces", runtimeUserScope: "storage", projectScoped: true, error: null };
	await buttonByText(tree, "刷新").props.onClick();
	tree = await renderer.settle();
	assert.ok(textOf(tree).includes("项目记忆已按工作区隔离"), "已隔离应显示中性提示");
	assert.ok(textOf(tree).includes("storageScope = workspaces"), "应显示实际 storageScope");
}

console.log("INTERACTION SMOKE OK");
