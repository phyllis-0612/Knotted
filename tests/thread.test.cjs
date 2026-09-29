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
            prepareCompression: prepareCompressionPlan, restoreCompression: restoreCompressionBackup,
            hasBackup: hasCompressBackup, autoCompress: checkAndRunAutoCompress,
            summaryType: function (type) { selectedSummaryType = type; },
            book: function (name) { currentPrimaryLorebook = name; },
            compressionSettings: function (settings) {
                if ('fresh' in settings) currentFreshCount = settings.fresh;
                if ('floor' in settings) currentCompressFloorChars = settings.floor;
                if ('auto' in settings) autoCompressEnabled = settings.auto;
                if ('threshold' in settings) currentCompressThreshold = settings.threshold;
            },
            threadOptions: getThreadRequestOptions, deleteProfile: deleteCurrentApiProfile,
            remove: function (ids) {
                var m = readChatMemory();
                removeThreadNodesForSegments(m, m.segments.filter(s => ids.includes(s.layerId)));
                m.segments = m.segments.filter(s => !ids.includes(s.layerId));
                writeChatMemory(m); threadRevision++; refreshInjection();
            },
            summary: proceedWithSummarization, initialize: mainInitializeSummarizer,
            maxLorebookFloor: getMaxSummarizedFloorFromActiveLorebookEntry,
            syncMemory: syncThreadInjection, manageLorebook: manageSummaryLorebookEntries,
            setSummaryHeader: function (text) { currentLorebookHeaderText = text; },
            get summaryHeader() { return DEFAULT_LOREBOOK_HEADER_TEXT; },
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
        plugin, api, context, helper, entries, requests, replies, toasts, settings, injections, events,
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

for (const mode of ['lorebook', 'inject']) test(mode + '连续小总结只在整份记忆开头放一次说明，单段与脉络请求不包含抬头', async () => {
    const h = harness(), p = h.plugin, header = p.summaryHeader;
    p.mode(mode);
    for (let i = 0; i < 3; i++) {
        h.replies.push(jsonResponse(header + '\n\n' + header + '\n\n正文' + i), jsonResponse('[阶段' + i + '] 事件'));
        assert.equal(await p.summary(i * 10, i * 10 + 9, mode === 'lorebook'), true);
    }
    const content = mode === 'lorebook' ? h.entries[0].content : p.build();
    assert.equal(content.split(header).length - 1, 1);
    assert.ok(content.indexOf(header) < content.indexOf('正文0'));
    const segments = mode === 'lorebook' ? p.lorebookSegments(h.entries[0]) : p.read().segments;
    assert.deepEqual(clone(segments.map(s => s.text)), ['正文0', '正文1', '正文2']);
    h.requests.filter((_, i) => i % 2).forEach((request, i) => {
        assert.equal(request.body.messages[1].content.split('【最新总结】\n')[1], '正文' + i);
    });
});

test('世界书旧数据在首段、分隔符前后重复的说明被清理，范围和正文保留', async () => {
    const h = harness(), p = h.plugin, header = p.summaryHeader;
    p.mode('lorebook');
    h.entries.push({ uid: 1, enabled: true, comment: '小总结-Chat-A-1-20',
        content: header + '\n\n旧段一\n\n' + header + '\n\n---\n[11-20]\n' + header + '\n\n旧段二' });
    assert.equal(await p.maxLorebookFloor(), 19);
    assert.deepEqual(clone(p.lorebookSegments(h.entries[0]).map(s => [s.startFloor, s.endFloor, s.text])),
        [[0, 9, '旧段一'], [10, 19, '旧段二']]);
    assert.equal(h.entries[0].content.split(header).length - 1, 1);
    // 再次加载及后续追加都不会把已去掉的说明加回来。
    await p.maxLorebookFloor();
    h.replies.push(jsonResponse('新段三'), () => { throw new Error('thread offline'); });
    assert.equal(await p.summary(20, 29, true), true);
    assert.equal(h.entries[0].content.split(header).length - 1, 1);
    assert.deepEqual(clone(p.lorebookSegments(h.entries[0]).map(s => s.text)), ['旧段一', '旧段二', '新段三']);
});

test('多个启用的世界书总结块共用一个抬头，其他聊天、类型与普通条目不改写', async () => {
    const h = harness(), p = h.plugin, header = p.summaryHeader;
    p.mode('lorebook');
    h.entries.push(
        { uid: 1, enabled: true, comment: '小总结-Chat-A-1-10', content: header + '\n\n---\n[1-10]\n一', keys: ['keep'], order: 12 },
        { uid: 2, enabled: true, comment: '小总结-Chat-A-11-20', content: header + '\n\n---\n[11-20]\n二', order: 13 },
        { uid: 3, enabled: true, comment: '小总结-Chat-B-1-10', content: header + '\n\n其他聊天' },
        { uid: 4, enabled: false, comment: '大总结-Chat-A-1-20', content: header + '\n\n其他类型' },
        { uid: 5, enabled: true, comment: '人物设定', content: header + '\n\n普通条目' }
    );
    const others = clone(h.entries.slice(2));
    await p.syncMemory();
    assert.equal(h.entries.slice(0, 2).map(e => e.content).join('\n').split(header).length - 1, 1);
    assert.deepEqual(clone(h.entries.slice(2)), others);
    assert.deepEqual(h.entries[0].keys, ['keep']);
    assert.equal(h.entries[0].order, 12);
    const first = clone(h.entries);
    await p.syncMemory();
    assert.deepEqual(h.entries, first);
});

test('注入旧段与自定义说明去重，正文中的行内引用和楼层标签保留', () => {
    const h = harness(), p = h.plugin, header = '自定义说明 [.*] {{char}}\n仅作时间线参考';
    p.setSummaryHeader(header);
    const quote = '角色读到“' + p.summaryHeader.split('\n')[0] + '”，继续讲述。';
    h.metadata.autoSummaryAdv_v1 = { header, segments: [
        { startFloor: 0, endFloor: 9, gen: 0, text: header + '\r\n\r\n' + quote },
        { startFloor: 10, endFloor: 19, gen: 2, text: p.summaryHeader + '\n\n第二段' }
    ] };
    const original = clone(h.metadata);
    const content = p.build();
    assert.equal(content.split(header).length - 1, 1);
    assert.ok(content.includes(quote));
    assert.ok(content.includes('[1-10]'));
    assert.ok(content.includes('11-20]'));
    assert.ok(content.includes('第二段'));
    assert.deepEqual(h.metadata, original); // 构造注入文本不原地更改旧数据。
});

test('只有抬头的模型响应不被保存成有效总结', async () => {
    const h = harness();
    h.replies.push(jsonResponse(h.plugin.summaryHeader));
    assert.equal(await h.plugin.summary(0, 9, false), false);
    assert.equal(h.plugin.read().segments.length, 0);
    assert.equal(h.requests.length, 1);
});

test('压缩、撤销及旧注入记忆重建脉络均只处理剧情正文', async () => {
    const h = harness(), p = h.plugin, header = p.summaryHeader;
    h.metadata.autoSummaryAdv_v1 = { segments: [0, 1, 2].map(i => ({
        startFloor: i * 10, endFloor: i * 10 + 9, gen: 0, text: header + '\n\n剧情' + i
    })) };
    h.replies.push(jsonResponse(header + '\n\n合并剧情'));
    assert.equal((await p.compress()).ok, true);
    assert.ok(!h.requests[0].body.messages[1].content.includes(header));
    assert.equal(p.read().segments[0].text, '合并剧情');
    assert.equal(p.build().split(header).length - 1, 1);
    assert.equal(p.restore(), 3);
    assert.deepEqual(clone(p.read().segments.map(s => s.text)), ['剧情0', '剧情1', '剧情2']);
    // 模拟尚未保存过的旧元数据，重建调用也不携带重复说明。
    h.metadata.autoSummaryAdv_v1.segments[0].text = header + '\n\n剧情0';
    h.replies.push(jsonResponse('[一] 剧情0'), jsonResponse('[二] 剧情1'), jsonResponse('[三] 剧情2'));
    assert.equal(await p.rebuild(), true);
    h.requests.slice(1).forEach(request => assert.ok(!request.body.messages[1].content.includes(header)));
});

test('自定义头部是默认头部前半句时，清理完整默认说明而不遗留 System Note', async () => {
    const h = harness(), p = h.plugin;
    p.setSummaryHeader(p.summaryHeader.split('\n')[0]);
    h.replies.push(jsonResponse(p.summaryHeader + '\n\n正文'), jsonResponse('[日] 事件'));
    assert.equal(await p.summary(0, 9, false), true);
    assert.equal(p.read().segments[0].text, '正文');
    assert.ok(!p.build().includes('[System Note:'));
});

async function worldCompressionFixture(separate = false) {
    const h = harness(), p = h.plugin;
    p.mode('lorebook');
    const bodies = ['初遇的剧情'.repeat(30), '相爱的剧情'.repeat(30), '最后一段保鲜剧情'];
    const entry = (uid, start, end, content) => ({ uid, enabled: true, type: 'constant', keys: ['keep'],
        position: 'before_character_definition', order: uid, comment: '小总结-Chat-A-' + start + '-' + end, content });
    if (separate) h.entries.push(...bodies.map((body, i) => entry(i + 1, i * 10 + 1, i * 10 + 10,
        '---\n[' + (i * 10 + 1) + '-' + (i * 10 + 10) + ']\n' + body)));
    else h.entries.push(entry(1, 1, 30, bodies.map((body, i) => '---\n[' + (i * 10 + 1) + '-' + (i * 10 + 10) + ']\n' + body).join('\n')));
    h.entries.push({ uid: 10, enabled: false, comment: '大总结-Chat-A-1-30', content: '大总结保持' },
        { uid: 11, enabled: false, comment: '小总结-Chat-B-1-10', content: '其他聊天保持' },
        { uid: 12, enabled: true, comment: '设定', content: '普通条目保持' });
    p.write({ ...p.read(), segments: [{ layerId: 'inject_90_99', startFloor: 90, endFloor: 99, gen: 0, text: '注入记忆保持' }],
        threadNodes: bodies.map((_, i) => ({ id: 'n' + i, layerId: 'summary_' + i * 10 + '_' + (i * 10 + 9), text: '[日' + i + '] 事件' })) });
    await p.syncMemory();
    return h;
}

for (const separate of [false, true]) test('世界书压缩' + (separate ? '多个条目' : '单条多段') + '，保鲜、脉络、属性和其他记忆不变，撤销可恢复', async () => {
    const h = await worldCompressionFixture(separate), p = h.plugin;
    const original = clone(h.entries), nodes = clone(p.read().threadNodes), inject = clone(p.read().segments);
    const plan = await p.prepareCompression();
    assert.equal(plan.ok, true);
    assert.equal(plan.toCompress.length, 2);
    assert.equal(plan.fresh.length, 1);
    h.replies.push(jsonResponse(p.summaryHeader + '\n\n初遇后相爱'));
    const result = await p.compress();
    assert.equal(result.ok, true);
    assert.equal(result.after, '初遇后相爱'.length + '最后一段保鲜剧情'.length);
    const active = h.entries.filter(e => e.enabled && e.comment.startsWith('小总结-Chat-A-'));
    assert.equal(active.length, 1);
    assert.deepEqual(clone(p.lorebookSegments(active[0]).map(s => [s.gen, s.startFloor, s.endFloor, s.text])),
        [[1, 0, 19, '初遇后相爱'], [0, 20, 29, '最后一段保鲜剧情']]);
    assert.equal(active[0].content.split(p.summaryHeader).length - 1, 1);
    assert.deepEqual(clone(p.read().threadNodes), nodes);
    assert.deepEqual(clone(p.read().segments), inject);
    assert.deepEqual(clone(h.entries.slice(separate ? 3 : 1)), original.slice(separate ? 3 : 1));
    assert.deepEqual(active[0].keys, ['keep']);
    await p.manageLorebook(); // 重开聊天/切换总结类型不能重新启用压缩前的旧条目。
    assert.equal(h.entries.filter(e => e.enabled && e.comment.startsWith('小总结-Chat-A-')).length, 1);
    assert.equal((await p.prepareCompression()).source.segments.length, 2);
    assert.ok(p.hasBackup());
    assert.ok(!h.requests[0].body.messages[1].content.includes(p.summaryHeader));
    assert.ok(!h.requests[0].body.messages[1].content.includes('最后一段保鲜剧情'));
    assert.ok(!h.requests[0].body.messages[1].content.includes('注入记忆保持'));
    await p.saveEdited('[人工] 我的脉络');
    assert.equal(await p.restoreCompression(), 3);
    assert.equal(p.read().threadNodes[0].text, '[人工] 我的脉络');
    assert.deepEqual(clone(p.read().segments), inject);
    assert.deepEqual(clone(p.lorebookSegments(h.entries[0]).map(s => s.text)),
        separate ? ['初遇的剧情'.repeat(30)] : ['初遇的剧情'.repeat(30), '相爱的剧情'.repeat(30), '最后一段保鲜剧情']);
    assert.deepEqual(clone(h.entries.slice(separate ? 3 : 1)), original.slice(separate ? 3 : 1));
});

test('世界书压缩后追加、再次压缩、重建和删除压缩段保留完整来源关联', async () => {
    const h = await worldCompressionFixture(), p = h.plugin;
    h.replies.push(jsonResponse('压缩一'));
    assert.equal((await p.compress()).ok, true);
    h.replies.push(jsonResponse('新段'), jsonResponse('[新] 新事件'));
    assert.equal(await p.summary(30, 39, true), true);
    assert.equal(p.lorebookSegments(h.entries[0])[0].gen, 1);
    // 追加后拒绝旧备份覆盖新总结。
    assert.equal(await p.restoreCompression(), -1);
    assert.ok(h.entries[0].content.includes('新段'));
    p.compressionSettings({ floor: 0 });
    const nodes = clone(p.read().threadNodes);
    h.replies.push(jsonResponse('压缩二'));
    assert.equal((await p.compress()).ok, true);
    const segments = p.lorebookSegments(h.entries[0]);
    assert.equal(segments[0].gen, 2);
    assert.equal(segments[0].endFloor, 29);
    assert.ok(segments[0].sourceLayerIds.includes('summary_0_9'));
    assert.ok(segments[0].sourceLayerIds.includes('summary_10_19'));
    assert.deepEqual(clone(p.read().threadNodes), nodes);
    h.replies.push(jsonResponse('[旧] 合并事件'), jsonResponse('[新] 新段事件'));
    assert.equal(await p.rebuild(), true);
    assert.ok(h.requests[h.requests.length - 2].body.messages[1].content.endsWith('压缩二'));
    h.entries[0].content = '---\n[31-40]\n新段';
    await p.maxLorebookFloor();
    assert.deepEqual(clone(p.read().threadNodes.map(n => n.layerId)), ['summary_30_39']);
});

test('世界书压缩 API 或备份失败不会改写条目；部分写入失败自动恢复', async () => {
    const h = await worldCompressionFixture(true), p = h.plugin, original = clone(h.entries);
    h.replies.push(new Response('offline', { status: 503 }));
    assert.equal((await p.compress()).ok, false);
    assert.deepEqual(h.entries, original);
    h.context.saveMetadataDebounced = () => { throw new Error('save failed'); };
    assert.equal((await p.compress()).ok, false);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.entries, original);
    h.context.saveMetadataDebounced = () => {};
    const write = h.helper.setLorebookEntries;
    let fail = true;
    h.helper.setLorebookEntries = async (book, changes) => {
        if (fail) { fail = false; await write(book, changes.slice(0, 1)); throw new Error('partial write'); }
        return write(book, changes);
    };
    h.replies.push(jsonResponse('压缩'));
    assert.equal((await p.compress()).ok, false);
    assert.deepEqual(h.entries, original);
    assert.equal(p.read().threadNodes.length, 3);
});

test('世界书压缩过程中编辑、切换聊天、世界书或总结类型时不覆盖新的内容', async () => {
    for (const change of ['edit', 'chat', 'book', 'type']) {
        const h = await worldCompressionFixture(), p = h.plugin;
        h.replies.push(() => {
            if (change === 'edit') h.entries[0].content += '\n用户修改';
            if (change === 'chat') h.switchChat('Chat-B');
            if (change === 'book') p.book('Another-Book');
            if (change === 'type') p.summaryType('large');
            return jsonResponse('旧任务压缩');
        });
        assert.equal((await p.compress()).ok, false);
        assert.ok(!h.entries[0].content.includes('旧任务压缩'));
        if (change === 'edit') assert.ok(h.entries[0].content.includes('用户修改'));
    }
});

test('世界书自动压缩按世界书正文阈值触发并使用独立压缩预设', async () => {
    const h = await worldCompressionFixture(), p = h.plugin;
    h.entries[0].content += '很长的剧情'.repeat(250);
    h.settings.autoSummaryWorldbookAdv.apiProfiles.push({ id: 'compress-only', name: '压缩', model: 'compress-model',
        url: 'https://compress.test/v1', apiKey: 'compress-test-only' });
    h.settings.autoSummaryWorldbookAdv.compressProfileId = 'compress-only';
    p.compressionSettings({ auto: true, threshold: 1000 });
    h.replies.push(jsonResponse('自动压缩'));
    await p.autoCompress();
    assert.equal(h.requests[0].url, 'https://compress.test/v1/chat/completions');
    assert.equal(h.requests[0].body.model, 'compress-model');
    assert.ok(h.entries[0].content.includes('自动压缩'));
    assert.equal(p.read().segments[0].text, '注入记忆保持');
});

test('世界书保底段和楼层空隙不会被包进重叠压缩区间', async () => {
    const h = await worldCompressionFixture(), p = h.plugin;
    h.entries[0].comment = '小总结-Chat-A-1-60';
    h.entries[0].content = '---\n[1-10]\n一\n---\n[已压缩·1代 11-20]\n保底\n---\n[21-30]\n三\n---\n[31-40]\n四\n---\n[51-60]\n保鲜';
    const plan = await p.prepareCompression();
    assert.deepEqual(clone(plan.toCompress.map(s => [s.startFloor, s.endFloor])), [[20, 29], [30, 39]]);
    h.replies.push(jsonResponse('三四合并'));
    assert.equal((await p.compress()).ok, true);
    assert.deepEqual(clone(p.lorebookSegments(h.entries[0]).map(s => [s.startFloor, s.endFloor])), [[0, 9], [10, 19], [20, 39], [50, 59]]);
});

test('压缩失败保留上一次成功的世界书备份，撤销与模式、聊天、世界书、总结类型隔离', async () => {
    const h = await worldCompressionFixture(), p = h.plugin;
    h.replies.push(jsonResponse('第一次压缩'));
    assert.equal((await p.compress()).ok, true);
    assert.ok(p.hasBackup());
    p.mode('inject'); assert.equal(p.hasBackup(), false);
    p.mode('lorebook'); p.book('另一本'); assert.equal(p.hasBackup(), false);
    p.book('Book'); p.summaryType('large'); assert.equal(p.hasBackup(), false);
    p.summaryType('small'); assert.ok(p.hasBackup());
    const raw = clone(h.metadata), originalEntries = clone(h.entries);
    const previousBackup = clone(h.metadata.autoSummaryAdv_v1_backup_lorebook);
    h.entries[0].comment = '小总结-Chat-A-1-40';
    h.entries[0].content += '\n---\n[31-40]\n新保鲜段';
    p.compressionSettings({ floor: 0 });
    h.replies.push(new Response('offline', { status: 503 }));
    assert.equal((await p.compress()).ok, false);
    assert.deepEqual(clone(h.metadata.autoSummaryAdv_v1_backup_lorebook), previousBackup);
    const reloaded = harness();
    Object.assign(reloaded.metadata, raw); reloaded.entries.push(...originalEntries);
    reloaded.plugin.mode('lorebook');
    assert.equal(reloaded.plugin.lorebookSegments(reloaded.entries[0])[0].gen, 1);
    assert.ok(reloaded.plugin.lorebookSegments(reloaded.entries[0])[0].sourceLayerIds.includes('summary_10_19'));
    assert.equal(await reloaded.plugin.restoreCompression(), 3);
    assert.equal(reloaded.plugin.read().threadNodes.length, 3);
    assert.equal(reloaded.plugin.hasBackup(), false);
    h.switchChat('Chat-B'); assert.equal(p.hasBackup(), false);
});

test('世界书自动压缩在本轮总结保存之后调用，失败不影响总结成功', async () => {
    const h = await worldCompressionFixture(), p = h.plugin;
    h.entries[0].content += '很长的剧情'.repeat(250);
    p.compressionSettings({ auto: true, threshold: 1000 });
    h.replies.push(jsonResponse('本轮总结'), jsonResponse('[本轮] 事件'), new Response('offline', { status: 503 }));
    assert.equal(await p.summary(30, 39, true), true);
    assert.equal(h.requests.length, 3);
    assert.ok(h.entries[0].content.includes('本轮总结'));
    assert.equal(p.lorebookSegments(h.entries[0]).length, 4);
});

test('世界书区间重叠、主世界书缺失和可压缩段不足不会请求模型', async () => {
    const h = await worldCompressionFixture(), p = h.plugin;
    h.entries.push({ uid: 20, comment: '小总结-Chat-A-5-15', enabled: true, content: '重叠总结' });
    assert.equal((await p.compress()).ok, false);
    h.entries.pop();
    p.book(null); assert.equal((await p.compress()).ok, false);
    p.book('Book'); p.compressionSettings({ fresh: 2 });
    assert.equal((await p.compress()).ok, false);
    assert.equal(h.requests.length, 0);
});

test('世界书压缩和撤销期间使用互斥锁，第二次任务不会发起调用', async () => {
    const h = await worldCompressionFixture(), p = h.plugin, hold = deferred(), sent = deferred();
    h.replies.push(() => { sent.resolve(); return hold.promise; });
    const work = p.compress();
    await sent.promise;
    assert.equal((await p.compress()).ok, false);
    assert.equal(await p.restoreCompression(), -1);
    assert.equal(await p.summary(30, 39, true), false);
    hold.resolve(jsonResponse('压缩结果'));
    assert.equal((await work).ok, true);
    assert.equal(h.requests.length, 1);
});

test('世界书撤销部分写入失败时恢复压缩后的条目，并保留可重试备份', async () => {
    const h = await worldCompressionFixture(true), p = h.plugin;
    h.replies.push(jsonResponse('已压缩'));
    assert.equal((await p.compress()).ok, true);
    const compressed = clone(h.entries), write = h.helper.setLorebookEntries;
    let fail = true;
    h.helper.setLorebookEntries = async (book, changes) => {
        if (fail) { fail = false; await write(book, changes.slice(0, 1)); throw new Error('partial undo'); }
        return write(book, changes);
    };
    assert.equal(await p.restoreCompression(), -1);
    assert.deepEqual(h.entries, compressed);
    assert.ok(p.hasBackup());
    assert.equal(await p.restoreCompression(), 3);
    assert.equal(p.hasBackup(), false);
});

test('世界书大总结可压缩，小总结和其他类型的来源关联不变', async () => {
    const h = await worldCompressionFixture(), p = h.plugin;
    h.entries[0].enabled = false;
    const large = h.entries.find(e => e.uid === 10);
    large.enabled = true;
    large.content = '---\n[1-10]\n大一\n---\n[11-20]\n大二\n---\n[21-30]\n大三';
    p.summaryType('large');
    const small = clone(h.entries[0]);
    h.replies.push(jsonResponse('大总结压缩'));
    assert.equal((await p.compress()).ok, true);
    assert.deepEqual(h.entries[0], small);
    assert.equal(p.lorebookSegments(large)[0].gen, 1);
    assert.equal(await p.restoreCompression(), 3);
});

for (const action of ['compress', 'undo']) test('世界书' + action + '写入失败时的自动恢复保留期间手改的脉络', async () => {
    const h = await worldCompressionFixture(true), p = h.plugin;
    if (action === 'undo') {
        h.replies.push(jsonResponse('已压缩'));
        assert.equal((await p.compress()).ok, true);
    }
    const write = h.helper.setLorebookEntries;
    let fail = true;
    h.helper.setLorebookEntries = async (book, changes) => {
        if (fail) {
            fail = false; await write(book, changes.slice(0, 1));
            await p.saveEdited('[人工] 最终事件线');
            throw new Error('partial write after manual edit');
        }
        return write(book, changes);
    };
    if (action === 'compress') {
        h.replies.push(jsonResponse('失败的压缩'));
        assert.equal((await p.compress()).ok, false);
    } else assert.equal(await p.restoreCompression(), -1);
    assert.equal(p.read().threadNodes[0].text, '[人工] 最终事件线');
    assert.ok(h.entries.filter(e => e.enabled && e.comment.startsWith('小总结-Chat-A-')).some(e => e.content.includes('[人工] 最终事件线')));
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

function addThreadProfile(h) {
    const profile = { id: 'thread-api', name: '脉络专用', url: 'https://thread.test/v1', apiKey: 'thread-test-only', model: 'thread-model' };
    h.settings.autoSummaryWorldbookAdv.apiProfiles.push(profile);
    h.settings.autoSummaryWorldbookAdv.threadProfileId = profile.id;
    return profile;
}

test('脉络可选独立 API 预设，自动总结仍使用原配置', async () => {
    const h = harness();
    addThreadProfile(h);
    h.replies.push(jsonResponse('总结全文'), jsonResponse('[夏] 初遇'));
    assert.equal(await h.plugin.summary(0, 9, false), true);
    const [summary, thread] = h.requests;
    assert.equal(summary.url, 'https://example.test/v1/chat/completions');
    assert.equal(summary.body.model, 'summary-model');
    assert.equal(thread.url, 'https://thread.test/v1/chat/completions');
    assert.equal(thread.body.model, 'thread-model');
    assert.equal(thread.headers.Authorization, 'Bearer thread-test-only');
    assert.equal(thread.body.messages[1].content, '【已有脉络】\n（空）\n\n【最新总结】\n总结全文');
    assert.equal(h.settings.autoSummaryWorldbookAdv.activeProfileId, 'test');
});

test('独立预设同样适用于逐段重建，运行中修改下次生效', async () => {
    const h = harness(), p = h.plugin, profile = addThreadProfile(h);
    p.append(0, 9, '一'); p.append(10, 19, '二');
    h.replies.push(() => {
        profile.model = 'modified-model';
        h.settings.autoSummaryWorldbookAdv.threadProfileId = '';
        return jsonResponse('[一] 节点');
    }, jsonResponse('[二] 节点'));
    assert.equal(await p.rebuild(), true);
    assert.deepEqual(h.requests.map(r => [r.url, r.body.model]), [
        ['https://thread.test/v1/chat/completions', 'thread-model'],
        ['https://thread.test/v1/chat/completions', 'thread-model']
    ]);
    assert.equal(p.threadOptions().apiConfig.model, 'summary-model');
});

test('总结开始时固定所选脉络预设，中途切换不会混用配置', async () => {
    const h = harness(), profile = addThreadProfile(h);
    h.replies.push(() => {
        profile.model = 'modified-thread-model';
        h.settings.autoSummaryWorldbookAdv.threadProfileId = '';
        return jsonResponse('一');
    }, jsonResponse('[一] 节点'));
    await h.plugin.summary(0, 9, false);
    assert.equal(h.requests[1].body.model, 'thread-model');
    assert.equal(h.requests[1].url, 'https://thread.test/v1/chat/completions');
});

test('专用预设未填完整时保留总结，重建不会清空旧脉络', async () => {
    const h = harness(), profile = addThreadProfile(h);
    profile.model = '';
    await h.plugin.saveEdited('人工脉络');
    h.replies.push(jsonResponse('已保存的总结'));
    assert.equal(await h.plugin.summary(0, 9, false), true);
    assert.equal(h.requests.length, 1);
    assert.equal(h.plugin.read().segments[0].text, '已保存的总结');
    assert.equal(await h.plugin.rebuild(), false);
    assert.equal(h.plugin.read().threadNodes[0].text, '人工脉络');
    assert.ok(h.toasts.some(t => t.includes('脉络所用 API')));
});

test('配置档被删除或丢失时同步回退到跟随总结', () => {
    const h = harness(), profile = addThreadProfile(h);
    h.settings.autoSummaryWorldbookAdv.activeProfileId = profile.id;
    h.plugin.deleteProfile();
    assert.equal(h.settings.autoSummaryWorldbookAdv.threadProfileId, '');
    assert.equal(h.plugin.threadOptions().apiConfig.model, 'summary-model');
    h.settings.autoSummaryWorldbookAdv.threadProfileId = 'no-longer-exists';
    assert.equal(h.plugin.threadOptions().apiConfig.model, 'summary-model');
    assert.equal(h.settings.autoSummaryWorldbookAdv.threadProfileId, '');
});

test('默认跟随复用传入的本轮总结配置快照，且与压缩选择独立', () => {
    const h = harness();
    const profile = addThreadProfile(h);
    h.settings.autoSummaryWorldbookAdv.threadProfileId = '';
    h.settings.autoSummaryWorldbookAdv.compressProfileId = profile.id;
    const snapshot = { url: 'https://snapshot.test', apiKey: 'snapshot-key', model: 'snapshot-model' };
    const result = h.plugin.threadOptions({ apiConfig: snapshot, stream: true });
    assert.deepEqual(clone(result), { apiConfig: snapshot, stream: true });
    snapshot.model = 'changed';
    assert.equal(result.apiConfig.model, 'snapshot-model');
});
