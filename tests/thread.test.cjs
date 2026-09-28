const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function jsonResponse(content) {
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } });
}
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function harness() {
    const api = { id: 'test', name: 'Test', url: 'https://example.test/v1', apiKey: 'test-only', model: 'summary-model' };
    const settings = { autoSummaryWorldbookAdv: { activeProfileId: api.id, apiProfiles: [api] } };
    let metadata = {};
    let saves = 0;
    const requests = [], replies = [], toasts = [], injections = [], entries = [], events = new Map();
    const storage = new Map();
    const context = {
        extensionSettings: settings, chat: Array.from({ length: 50 }, () => ({})),
        get chatMetadata() { return metadata; },
        saveMetadataDebounced() { saves++; }, saveSettingsDebounced() {},
        setExtensionPrompt(...args) { injections.push(args); },
        name1: 'User', callGenericPopup() {}, POPUP_TYPE: { DISPLAY: 1 },
        eventSource: { on(name, cb) { if (!events.has(name)) events.set(name, []); events.get(name).push(cb); } },
        event_types: { CHAT_CHANGED: 'chat', MESSAGE_DELETED: 'deleted', MESSAGE_RECEIVED: 'received' }
    };
    const helper = {
        getLorebookEntries: async () => clone(entries),
        setLorebookEntries: async (_name, changes) => changes.forEach(change => Object.assign(entries.find(e => e.uid === change.uid), change)),
        createLorebookEntries: async (_name, changes) => {
            const ids = changes.map(change => { const uid = entries.length + 1; entries.push({ ...change, uid }); return uid; });
            return { new_uids: ids };
        },
        getChatMessages: async () => context.chat.map((_, i) => ({ message_id: i, role: 'assistant', message: '正文' + i })),
        getCurrentCharPrimaryLorebook: async () => 'Book'
    };
    const window = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } };
    window.parent = window;
    const sandbox = {
        window, document: {}, SillyTavern: { getContext: () => context },
        Response, TextDecoder, console: { log() {}, warn() {}, error() {} },
        setInterval() { return 1; }, clearInterval() {},
        setTimeout() { return 1; }, clearTimeout() {},
        fetch: async (url, options) => {
            requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
            if (!replies.length) throw new Error('Unexpected API request');
            const reply = replies.shift();
            return typeof reply === 'function' ? reply() : reply;
        }
    };
    vm.createContext(sandbox);
    const instrumented = source.replace(/\}\)\(\);\s*$/, `
        window.testApi = {
            read: readChatMemory, write: writeChatMemory, append: appendSummarySegment,
            trim: trimSegmentsAfterFloor, build: buildInjectionText, weave: weaveThreadForSummary,
            rebuild: rebuildThread, saveEdited: saveEditedThread, parseEdited: parseEditedThread,
            parse: parseThreadOutput, lorebookSegments: lorebookSummarySegments,
            call: callCustomOpenAI, compress: runCompression, restore: restoreMemoryFromBackup,
            remove: function (ids) {
                var m = readChatMemory();
                removeThreadNodesForSegments(m, m.segments.filter(s => ids.includes(s.layerId)));
                m.segments = m.segments.filter(s => !ids.includes(s.layerId));
                writeChatMemory(m); threadRevision++; refreshInjection();
            },
            summary: proceedWithSummarization, initialize: mainInitializeSummarizer,
            maxLorebookFloor: getMaxSummarizedFloorFromActiveLorebookEntry,
            initEvents: function () { window.jQuery = () => ({ length: 0 }); mainInitializeSummarizer(); },
            get header() { return THREAD_HEADER; },
            get locks() { return { isSummaryInFlight, isRebuildingThread }; },
            setup: function (ctx, helper, toast) {
                extension_settings = ctx.extensionSettings; SillyTavern_API = ctx; TavernHelper_API = helper;
                toastr_API = { warning: toast, error: toast, info: toast, success: toast };
                coreApisAreReady = true; stCaps.chatMetadata = true; stCaps.saveMetadata = true;
                stCaps.setExtensionPrompt = true; stCaps.injectReady = true;
                currentStorageMode = 'inject'; currentChatFileIdentifier = 'Chat-A'; currentPrimaryLorebook = 'Book';
                currentSummaryPrompt = '总结提示词'; currentBreakArmorPrompt = '可选前缀';
                streamSummaryEnabled = false; autoCompressEnabled = false; autoSummaryEnabled = false;
                allChatMessages = ctx.chat.map((_, i) => ({ message: '原始正文' + i, name: 'A' }));
                currentFreshCount = 1;
            },
            switchChat: function (name) { currentChatFileIdentifier = name; chatEpoch++; threadRevision++; },
            mode: function (mode) { currentStorageMode = mode; },
            jquery: function (jq) { jQuery_API = jq; },
        };
    })();`);
    vm.runInContext(instrumented, sandbox);
    const plugin = window.testApi;
    plugin.setup(context, helper, text => toasts.push(text));
    return {
        plugin, api, context, entries, requests, replies, toasts, settings, injections, events,
        get metadata() { return metadata; }, get saves() { return saves; },
        switchChat(name, next = {}) { metadata = next; plugin.switchChat(name); }
    };
}

test('解析仅保留方括号行；冷启动保留全部，之后只取第一条且旧节点不变', async () => {
    const h = harness(), p = h.plugin;
    h.replies.push(jsonResponse('说明\n[1999年夏] 初遇\n[1999年秋] 相爱\n[缺右括号\n```'));
    await p.weave('summary_0_9', '初遇与相爱', {});
    const old = clone(p.read().threadNodes);
    assert.equal(old.length, 2);
    h.replies.push(jsonResponse('[2000年冬] 分手\n[额外] 应丢弃'));
    await p.weave('summary_10_19', '分手', {});
    assert.deepEqual(clone(p.read().threadNodes.slice(0, 2)), old);
    assert.equal(p.read().threadNodes.length, 3);
    assert.equal(h.requests[1].body.messages[1].content, '【已有脉络】\n[1999年夏] 初遇\n[1999年秋] 相爱\n\n【最新总结】\n分手');
    assert.ok(h.saves >= 2);
    assert.equal(h.settings.autoSummaryWorldbookAdv.threadNodes, undefined);
});

test('总结先保存再请求脉络；两次请求使用同一配置且只替换提示词', async () => {
    const h = harness();
    h.replies.push(jsonResponse('本次总结全文'), () => {
        assert.equal(h.plugin.read().segments[0].text, '本次总结全文');
        h.api.model = 'new-model';
        return jsonResponse('[夏] 初遇');
    });
    assert.equal(await h.plugin.summary(0, 9, false), true);
    const [summary, thread] = h.requests;
    assert.equal(summary.url, thread.url);
    assert.deepEqual(summary.headers, thread.headers);
    assert.equal(summary.body.model, thread.body.model);
    assert.equal(summary.body.stream, thread.body.stream);
    assert.equal(summary.body.messages[0].content, '可选前缀\n\n总结提示词');
    assert.ok(!thread.body.messages[0].content.includes('可选前缀'));
    assert.equal(thread.body.messages[1].content, '【已有脉络】\n（空）\n\n【最新总结】\n本次总结全文');
    const built = h.plugin.build();
    assert.ok(built.startsWith(h.plugin.header + '\n[夏] 初遇\n\n'));
    assert.ok(built.indexOf('以下是本故事的历史总结') < built.indexOf('本次总结全文'));
    assert.equal(h.plugin.locks.isSummaryInFlight, false);
});

for (const [name, reply] of [
    ['HTTP错误', new Response('upstream unavailable', { status: 503 })],
    ['无有效行', jsonResponse('普通说明文字')],
    ['网络错误', () => { throw new Error('network error'); }]
]) test('脉络' + name + '不会回滚或判失败已经保存的总结', async () => {
    const h = harness();
    h.replies.push(jsonResponse('已保存的总结'), reply);
    assert.equal(await h.plugin.summary(0, 9, false), true);
    assert.equal(h.plugin.read().segments[0].text, '已保存的总结');
    assert.equal(h.plugin.read().threadNodes.length, 0);
    assert.ok(h.toasts.some(t => t.includes('脉络更新失败')));
});

test('重跑同一总结替换原位置节点，不重复追加；删除总结同步清理', async () => {
    const h = harness(), p = h.plugin;
    h.replies.push(jsonResponse('初稿'), jsonResponse('[夏] 初遇'), jsonResponse('第二段'), jsonResponse('[秋] 相爱'));
    await p.summary(0, 9, false); await p.summary(10, 19, false);
    const other = clone(p.read().threadNodes[1]);
    h.replies.push(jsonResponse('改稿'), jsonResponse('[夏] 再次确认初遇\n[多余] 丢弃'));
    await p.summary(0, 9, false);
    assert.equal(p.read().segments.length, 2);
    assert.equal(p.read().segments[0].text, '改稿');
    assert.equal(p.read().threadNodes.length, 2);
    assert.deepEqual(clone(p.read().threadNodes[1]), other);
    p.remove(['summary_0_9']);
    assert.deepEqual(clone(p.read().threadNodes), [other]);
});

test('手动编辑接受不带方括号的文本，保留未修改节点的关联，空文本清空', async () => {
    const h = harness(), p = h.plugin;
    h.replies.push(jsonResponse('[夏] 初遇\n[秋] 相爱'));
    await p.weave('summary_0_9', '内容', {});
    const old = clone(p.read().threadNodes);
    await p.saveEdited('我自己的脉络\n[秋] 相爱\n手动新增', old);
    const nodes = p.read().threadNodes;
    assert.equal(nodes[0].text, '我自己的脉络');
    assert.equal(nodes[0].layerId, old[0].layerId);
    assert.deepEqual(clone(nodes[1]), old[1]);
    assert.match(nodes[2].layerId, /^manual_/);
    await p.saveEdited(' \n\n');
    assert.equal(p.read().threadNodes.length, 0);
});

test('等待中的脉络结果不能覆盖用户刚保存的修改', async () => {
    const h = harness(), hold = deferred();
    h.replies.push(() => hold.promise);
    const work = h.plugin.weave('summary_0_9', 'summary', {});
    await h.plugin.saveEdited('用户自己的事实');
    hold.resolve(jsonResponse('[夏] 旧请求结果'));
    await assert.rejects(work, /已被修改/);
    assert.equal(h.plugin.read().threadNodes[0].text, '用户自己的事实');
});

test('切换聊天时隔离存储并拒绝旧响应，即使切回原聊天', async () => {
    const h = harness(), hold = deferred(), old = h.metadata;
    h.replies.push(() => hold.promise);
    const work = h.plugin.weave('summary_0_9', 'summary', {});
    h.switchChat('Chat-B');
    await h.plugin.saveEdited('B的脉络');
    assert.equal(old.autoSummaryAdv_v1, undefined);
    h.switchChat('Chat-A', old);
    hold.resolve(jsonResponse('[夏] 过期结果'));
    await assert.rejects(work, /已切换/);
    assert.equal(h.plugin.read().threadNodes.length, 0);
});

test('总结请求期间切换聊天，不把旧总结保存到新聊天', async () => {
    const h = harness(), hold = deferred();
    h.replies.push(() => hold.promise);
    const work = h.plugin.summary(0, 9, false);
    h.switchChat('Chat-B');
    hold.resolve(jsonResponse('旧聊天总结'));
    assert.equal(await work, false);
    assert.equal(h.plugin.read().segments.length, 0);
    assert.equal(h.requests.length, 1);
});

test('重建按楼层顺序逐次请求，下一段读到上一段脉络', async () => {
    const h = harness(), p = h.plugin, hold = deferred();
    p.append(10, 19, '第二段'); p.append(0, 9, '第一段');
    await p.saveEdited('旧脉络');
    h.replies.push(() => hold.promise, jsonResponse('[秋] 相爱'));
    const work = p.rebuild();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.requests.length, 1);
    assert.equal(p.read().threadNodes.length, 0);
    assert.ok(h.requests[0].body.messages[1].content.endsWith('第一段'));
    hold.resolve(jsonResponse('[夏] 初遇'));
    assert.equal(await work, true);
    assert.ok(h.requests[1].body.messages[1].content.includes('[夏] 初遇'));
    assert.ok(h.requests[1].body.messages[1].content.endsWith('第二段'));
    assert.deepEqual(clone(p.read().threadNodes.map(n => n.layerId)), ['summary_0_9', 'summary_10_19']);
});

test('重建中途失败停止调用并保留已完成节点与全部总结', async () => {
    const h = harness(), p = h.plugin;
    p.append(0, 9, '一'); p.append(10, 19, '二'); p.append(20, 29, '三');
    h.replies.push(jsonResponse('[夏] 一'), new Response('error', { status: 500 }));
    assert.equal(await p.rebuild(), false);
    assert.equal(h.requests.length, 2);
    assert.equal(p.read().threadNodes.length, 1);
    assert.equal(p.read().segments.length, 3);
    assert.equal(p.locks.isRebuildingThread, false);
});

test('空总结不触发重建，也不清空手动脉络', async () => {
    const h = harness();
    await h.plugin.saveEdited('手动脉络');
    assert.equal(await h.plugin.rebuild(), false);
    assert.equal(h.requests.length, 0);
    assert.equal(h.plugin.read().threadNodes[0].text, '手动脉络');
});

test('压缩保留节点与来源 ID；回退删除整个压缩段时同步删来源节点', async () => {
    const h = harness(), p = h.plugin;
    p.append(0, 9, '一'); p.append(10, 19, '二'); p.append(20, 29, '三');
    h.replies.push(jsonResponse('[一] 初遇'), jsonResponse('[二] 相爱'), jsonResponse('[三] 分手'));
    await p.weave('summary_0_9', '一', {}); await p.weave('summary_10_19', '二', {}); await p.weave('summary_20_29', '三', {});
    const nodes = clone(p.read().threadNodes);
    h.replies.push(jsonResponse('合并压缩一与二'));
    assert.equal((await p.compress()).ok, true);
    assert.deepEqual(clone(p.read().threadNodes), nodes);
    assert.ok(p.read().segments[0].sourceLayerIds.includes('summary_10_19'));
    p.trim(8);
    assert.equal(p.read().threadNodes.length, 0);
});

test('压缩后重建使用现存总结，撤销压缩不改用户脉络', async () => {
    const h = harness(), p = h.plugin;
    p.append(0, 9, '一'); p.append(10, 19, '二'); p.append(20, 29, '三');
    h.replies.push(jsonResponse('合并'), jsonResponse('[一二] 合并节点'), jsonResponse('[三] 三节点'));
    await p.compress();
    assert.equal(await p.rebuild(), true);
    assert.ok(h.requests[1].body.messages[1].content.endsWith('合并'));
    await p.saveEdited('人工编辑');
    assert.equal(p.restore(), 3);
    assert.equal(p.read().threadNodes[0].text, '人工编辑');
});

test('旧版元数据自动补齐稳定 ID，保存后节点可持久化回读', async () => {
    const h = harness();
    h.metadata.autoSummaryAdv_v1 = { segments: [{ gen: 0, startFloor: 0, endFloor: 9, text: '旧总结' }], header: '先行提示' };
    assert.equal(h.plugin.read().segments[0].layerId, 'summary_0_9');
    await h.plugin.saveEdited('[夏] 老节点');
    const stored = clone(h.metadata);
    h.switchChat('Chat-B'); h.switchChat('Chat-A', stored);
    assert.equal(h.plugin.read().threadNodes[0].text, '[夏] 老节点');
    assert.equal(h.plugin.read().header, '先行提示');
});

test('SSE与不支持流式时的回退由总结和脉络共用', async () => {
    const h = harness();
    h.replies.push(new Response('data: {"choices":[{"delta":{"content":"[夏] 初遇"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    await h.plugin.weave('summary_0_9', '一', { stream: true });
    assert.equal(h.plugin.read().threadNodes[0].text, '[夏] 初遇');
    h.replies.push(new Response('stream unsupported', { status: 400 }), jsonResponse('[秋] 相爱'));
    await h.plugin.weave('summary_10_19', '二', { stream: true });
    assert.equal(h.requests[1].body.stream, true);
    assert.equal(h.requests[2].body.stream, false);
});

test('世界书模式脉络与总结同块，重跑与重建使用逐段总结', async () => {
    const h = harness(), p = h.plugin;
    p.mode('lorebook');
    h.replies.push(jsonResponse('第一段'), jsonResponse('[夏] 初遇'), jsonResponse('第二段'), jsonResponse('[秋] 相爱'));
    assert.equal(await p.summary(0, 9, true), true);
    assert.equal(await p.summary(10, 19, true), true);
    assert.ok(h.entries[0].content.startsWith(p.header + '\n[夏] 初遇\n[秋] 相爱\n\n'));
    assert.deepEqual(clone(p.lorebookSegments(h.entries[0]).map(s => s.text)), ['第一段', '第二段']);
    h.replies.push(jsonResponse('改稿'), jsonResponse('[夏] 修订'));
    await p.summary(0, 9, true);
    assert.deepEqual(clone(p.lorebookSegments(h.entries[0]).map(s => s.text)), ['改稿', '第二段']);
    h.replies.push(jsonResponse('[夏] 重建一'), jsonResponse('[秋] 重建二'));
    assert.equal(await p.rebuild(), true);
    assert.ok(h.entries[0].content.includes('[秋] 重建二'));
    assert.equal(h.entries[0].content.split(p.header).length, 2);
});

test('旧版世界书首段无标记时从条目范围与后一段标记恢复', () => {
    const h = harness();
    const segments = h.plugin.lorebookSegments({ comment: '小总结-Chat-A-1-20', content: '第一段\n---\n[11-20]\n第二段' });
    assert.deepEqual(clone(segments.map(s => [s.startFloor, s.endFloor, s.text])), [[0, 9, '第一段'], [10, 19, '第二段']]);
});

test('部分重叠范围在调用前拒绝，避免总结和节点重复', async () => {
    const h = harness();
    h.plugin.append(0, 9, '已有总结');
    assert.equal(await h.plugin.summary(5, 14, false), false);
    assert.equal(h.requests.length, 0);
});

test('重建中手动保存立即优先，旧生成结果不会继续追加', async () => {
    const h = harness(), hold = deferred();
    h.plugin.append(0, 9, '一'); h.plugin.append(10, 19, '二');
    h.replies.push(() => hold.promise);
    const work = h.plugin.rebuild();
    await Promise.resolve(); await Promise.resolve();
    await h.plugin.saveEdited('用户优先');
    hold.resolve(jsonResponse('[旧] 模型'));
    assert.equal(await work, false);
    assert.equal(h.requests.length, 1);
    assert.equal(h.plugin.read().threadNodes[0].text, '用户优先');
});

test('保存函数报错时不把未持久化结果覆盖到内存', async () => {
    const h = harness();
    await h.plugin.saveEdited('原脉络');
    h.context.saveMetadataDebounced = () => { throw new Error('save failed'); };
    await assert.rejects(h.plugin.saveEdited('失败的修改'), /无法保存/);
    assert.equal(h.plugin.read().threadNodes[0].text, '原脉络');
});

test('删除世界书内某段或整个条目，同步清理对应节点', async () => {
    const h = harness(), p = h.plugin;
    p.mode('lorebook');
    h.replies.push(jsonResponse('一'), jsonResponse('[夏] 初遇'), jsonResponse('二'), jsonResponse('[秋] 相爱'));
    await p.summary(0, 9, true); await p.summary(10, 19, true);
    h.entries[0].content = '---\n[11-20]\n二';
    await p.maxLorebookFloor();
    assert.equal(p.read().threadNodes.length, 1);
    assert.equal(p.read().threadNodes[0].layerId, 'summary_10_19');
    h.entries.length = 0;
    await p.maxLorebookFloor();
    assert.equal(p.read().threadNodes.length, 0);
});

test('实际删楼事件立即清理超出范围的节点并使等待中的结果失效', async () => {
    const h = harness(), p = h.plugin, hold = deferred();
    p.append(0, 9, '一'); p.append(10, 19, '二');
    h.replies.push(jsonResponse('[夏] 一'), jsonResponse('[秋] 二'));
    await p.weave('summary_0_9', '一', {}); await p.weave('summary_10_19', '二', {});
    p.initEvents();
    h.replies.push(() => hold.promise);
    const work = p.weave('summary_20_29', '三', {});
    h.context.chat.length = 10;
    h.events.get('deleted')[0]();
    assert.equal(p.read().segments.length, 1);
    assert.equal(p.read().threadNodes.length, 1);
    hold.resolve(jsonResponse('[旧] 过期'));
    await assert.rejects(work, /已切换/);
    assert.equal(p.read().threadNodes.length, 1);
});

test('脉络请求期间拒绝另一个总结任务，避免乱序写入', async () => {
    const h = harness(), hold = deferred();
    h.replies.push(jsonResponse('一'), () => hold.promise);
    const work = h.plugin.summary(0, 9, false);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(await h.plugin.summary(10, 19, false), false);
    hold.resolve(jsonResponse('[夏] 初遇'));
    assert.equal(await work, true);
    assert.equal(h.requests.length, 2);
});

test('普通JSON内容数组同样适用于脉络请求', async () => {
    const h = harness();
    h.replies.push(jsonResponse([{ type: 'text', text: '[夏] ' }, { type: 'text', text: '初遇' }]));
    await h.plugin.weave('summary_0_9', '一', {});
    assert.equal(h.plugin.read().threadNodes[0].text, '[夏] 初遇');
});
