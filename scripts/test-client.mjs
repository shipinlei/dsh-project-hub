// 临时冒烟测试：不修改源码，只在 Node 里用 stub 执行 client bundle。
import fs from "node:fs";
import assert from "node:assert";

const file = process.argv[2];
const code = fs.readFileSync(file, "utf8");

let captured = null;
const dictionaries = {};
const hookStack = [];

function renderTree(type, props, children) {
	const node = { type: typeof type === "function" ? (type.name || "fn") : type };
	const nextProps = Object.assign({}, props || {});
	if (children.length) nextProps.children = children.length === 1 ? children[0] : children;
	if (typeof type === "function") {
		// 首帧渲染：hooks 每次返回初始值，setter 记录调用即可
		node.children = [type(nextProps)];
		return node;
	}
	node.props = nextProps;
	node.children = (children || []).map(function toNode(child) {
		if (child === null || child === undefined || typeof child === "boolean") return null;
		if (typeof child === "object" && child !== null && child.__element) return child;
		if (typeof child === "object") return child;
		return { type: "#text", text: String(child) };
	}).filter(Boolean);
	return Object.assign(node, { __element: true });
}

const react = {
	createElement(type, props) {
		const children = Array.prototype.slice.call(arguments, 2);
		return renderTree(type, props, children);
	},
	useState(initial) {
		const value = typeof initial === "function" ? initial() : initial;
		return [value, function setter() {}];
	},
	useRef(initial) { return { current: initial }; },
	useEffect(fn) { hookStack.push(fn); },
	useCallback(fn) { return fn; }
};

globalThis.window = { __ModuleLoader__: { load(opts) { captured = opts; } } };
globalThis.document = { baseURI: "http://127.0.0.1:14215/" };
Object.defineProperty(globalThis, "navigator", {
	value: { clipboard: { writeText: async function () {} } },
	configurable: true
});
globalThis.fetch = async function () {
	throw new Error("smoke: fetch 不应在首帧被调用");
};

new Function("window", "document", "require", code)(
	globalThis.window,
	globalThis.document,
	function requireStub(name) {
		if (name === "react") return react;
		throw new Error("unexpected require: " + name);
	}
);

assert.ok(captured, "factory 应捕获 __ModuleLoader__.load");
assert.strictEqual(captured.id, "dsh-project-hub", "loader id");
const mod = captured.factory(function requireStub(name) {
	if (name === "react") return react;
	throw new Error("unexpected require: " + name);
});
assert.strictEqual(mod.name, "dsh-project-hub");
assert.deepStrictEqual(Array.from(mod.inject), ["slots", "locale"]);
assert.strictEqual(typeof mod.apply, "function");

// ── 假 ctx ──────────────────────────────────────────────
const calls = [];
const fakeServices = {
	sessions: {
		async create(args) { calls.push(["create", args]); return "sess-1"; }
	},
	remote: {
		session: {
			async selectModel(args) { calls.push(["selectModel", args]); return { ok: true, value: undefined }; }
		}
	},
	uiWorkspace: {
		openSession(id) { calls.push(["openSession", id]); }
	}
};

let panelDef = null;
let panelComp = null;
let rowDef = null;
let rowComp = null;

function makeCtx(overrides) {
	const services = Object.assign({}, fakeServices, overrides && overrides.services);
	return {
		effect(fn) { fn(); },
		locale: {
			register(ns, dicts) { dictionaries[ns] = dicts; },
			bind() { return function t(key) { return (dictionaries["dsh-project-hub"] && dictionaries["dsh-project-hub"].zh[key]) || key; }; }
		},
		inject(deps, cb) {
			const scoped = {};
			deps.forEach(function (dep) { scoped[dep] = services[dep]; });
			cb(scoped);
		},
		get(name) { return services[name]; },
		slots: {
			inject(name, cb) { return cb(); },
			register(def, comp) {
				if (def.name === "main") { panelDef = def; panelComp = comp; }
				else { rowDef = def; rowComp = comp; }
				return function dispose() {};
			}
		}
	};
}

const ctx = makeCtx();
mod.apply(ctx);

assert.ok(panelDef, "应注册 main 面板");
assert.strictEqual(panelDef.key, "dsh-project-hub");
assert.strictEqual(panelDef.locale, "dsh-project-hub");
assert.ok(rowDef, "应注册 sidebar.panellist 入口");
assert.strictEqual(rowDef.id, "dsh-project-hub");
assert.strictEqual(rowDef.order, 4);
assert.strictEqual(typeof rowDef.label, "function");
assert.strictEqual(rowDef.label(), "项目");
assert.ok(dictionaries["dsh-project-hub"], "应注册中英文案");
assert.ok(dictionaries["dsh-project-hub"].zh && dictionaries["dsh-project-hub"].en, "zh/en 都必须存在");
const missingZh = Object.keys(dictionaries["dsh-project-hub"].en).filter(function (key) {
	return dictionaries["dsh-project-hub"].zh[key] === undefined;
});
assert.deepStrictEqual(missingZh, [], "zh 与 en 字典的键必须一致");

const injected = panelDef.inject();
assert.strictEqual(typeof injected.t, "function");
assert.strictEqual(typeof injected.createSession, "function");
assert.strictEqual(typeof injected.openSession, "function");

// ── 新建会话：create → selectModel → openSession ─────────
const defaults = { agentPreset: "standard", provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" };
await injected.createSession("ws-1", defaults);
assert.deepStrictEqual(calls, [
	["create", { workspaceId: "ws-1", agentPreset: "standard" }],
	["selectModel", { sessionId: "sess-1", provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" }],
	["openSession", "sess-1"]
], "调用顺序必须是 create → selectModel → openSession");

// ── 服务缺失：必须抛可读错误，不崩 ───────────────────────
let missing = null;
mod.apply(makeCtx({ services: { sessions: null, uiWorkspace: null } }));
try {
	await panelDef.inject().createSession("ws-2", {});
} catch (error) {
	missing = error;
}
assert.ok(missing && /会话服务/.test(missing.message), "缺 sessions 时应给出可读错误");

// ── create 抛错时错误应向上传递给面板 ────────────────────
mod.apply(makeCtx({
	services: { sessions: { async create() { throw new Error("boom-create"); } }, uiWorkspace: fakeServices.uiWorkspace }
}));
let createThrown = null;
try {
	await panelDef.inject().createSession("ws-3", {});
} catch (error) {
	createThrown = error;
}
assert.ok(createThrown && /boom-create/.test(createThrown.message), "create 失败应向上抛");

// ── selectModel 失败：应抛可读错误且不打开会话 ───────────
calls.length = 0;
mod.apply(makeCtx({
	services: {
		sessions: { async create() { return "sess-x"; } },
		remote: { session: { async selectModel() { throw new Error("boom-model"); } } },
		uiWorkspace: fakeServices.uiWorkspace
	}
}));
let modelThrown = null;
try {
	await panelDef.inject().createSession("ws-4", { provider: "p", model: "m" });
} catch (error) {
	modelThrown = error;
}
assert.ok(modelThrown && /项目默认模型应用失败/.test(modelThrown.message), "selectModel 失败应可读");
assert.ok(calls.every(function (call) { return call[0] !== "openSession"; }), "selectModel 失败后不应打开会话");

// ── 缺 remote.session.selectModel：同样可读报错，不静默 ──
mod.apply(makeCtx({ services: { sessions: { async create() { return "sess-y"; } }, remote: null } }));
let noWire = null;
try {
	await panelDef.inject().createSession("ws-5", { provider: "p", model: "m" });
} catch (error) {
	noWire = error;
}
assert.ok(noWire && /模型选择接口/.test(noWire.message), "缺 remote.session.selectModel 时应可读报错");

// ── 首帧渲染：面板/侧栏组件都能渲染 ─────────────────────
mod.apply(makeCtx());
const panelTree = panelComp({ t: panelDef.inject().t, useWorkspaces: function () { return []; }, useSessions: function () { return {}; } });
const texts = [];
(function collect(node) {
	if (!node) return;
	if (node.text !== undefined) texts.push(node.text);
	(node.children || []).forEach(collect);
})(panelTree);
const joined = texts.join("|");
assert.ok(joined.includes("项目工作台"), "首帧应渲染标题: " + joined.slice(0, 120));
assert.ok(joined.includes("正在读取项目…"), "首帧应渲染加载态");
assert.ok(joined.includes("刷新"), "首帧应渲染刷新按钮");
assert.ok(joined.includes("按工作区组织会话"), "首帧应渲染副标题");

const rowTree = rowComp({ size: 16 });
const svgNode = (function find(node) {
	if (!node) return null;
	if (node.type === "svg") return node;
	const list = node.children || [];
	for (let i = 0; i < list.length; i++) {
		const hit = find(list[i]);
		if (hit) return hit;
	}
	return null;
})(rowTree);
assert.ok(svgNode, "侧栏图标应渲染为 svg");
assert.strictEqual(svgNode.props.width, 16, "图标尺寸应跟随 owner.size");

console.log("SMOKE OK");
console.log("apply 注册：", panelDef.key, "/", rowDef.id, "/ order", rowDef.order, "/ label", rowDef.label());
console.log("首帧文本片段：", joined.slice(0, 160));
