// ===================================
// 1. 常量定义 - 放在文件最顶部
// ===================================

// 目标无头服务（Shopify Storefront API URL）
const HEADLESS_ORIGIN = "https://nuphy-develop-shop-7848d11901723dd15699.o2.myshopify.dev";

// 原始 Shopify 商店的域名 (用于构建回源 URL)
const SHOPIFY_ORIGIN_DOMAIN = "nuphy-develop.myshopify.com";
const SHOPIFY_ORIGIN = `https://${SHOPIFY_ORIGIN_DOMAIN}`;

// Shopify 要求的 Host Header (标准回源 Host)
const SHOPIFY_HOST_HEADER = "shops.myshopify.com";

// 性能优化：使用更高效的路由匹配结构
const HEADLESS_ROUTES = {
    // 精确匹配 (最快，O(1))
    exact: new Set([
        '/products/new-product-slug',
        '/custom-headless-page',
        '/cart',
        '/api/collect', // API 收集接口
        '/.well-known/shopify/monorail/unstable/produce_batch' // Shopify 数据收集
    ]),
    
    // 前缀匹配 (按长度排序，长的优先)
    prefixes: [
        '/.well-known/shopify/monorail/', // Shopify 监控相关
        '/collections/in-stock-keyboards/', // 实际的 collections 路径
        '/collections/new-collection-handle/', // 示例路径
        '/api/collect/',
        '/headless/'
    ],
    
    // 正则匹配 (最慢，最后使用)
    patterns: [
        /^\/collections\/[a-z0-9-]+\/products\/[a-z0-9-]+\.js$/, // .js 文件
        /^\/products\/[a-z0-9-]+\/(reviews|specs)$/,
        /^\/api\/collect\/[a-z0-9-]+$/
    ]
};

// 路由缓存 (LRU)
const routeCache = new Map();
const MAX_CACHE_SIZE = 1000;
let requestCount = 0;

// API 收集接口缓存配置
const API_COLLECT_CACHE_TTL = 300; // 5分钟
const apiCollectCache = new Map();

// Shopify Monorail 缓存配置 (更短的缓存时间)
const MONORAIL_CACHE_TTL = 60; // 1分钟
const monorailCache = new Map();

// HTTP 响应缓存配置 (用于缓存实际的 HTTP 响应)
const HTTP_RESPONSE_CACHE_TTL = 300; // 5分钟
const httpResponseCache = new Map();
const MAX_RESPONSE_CACHE_SIZE = 500; // 限制缓存大小

// ===================================
// 2. 性能监控和辅助函数定义
// ===================================

// 性能统计收集器
class PerformanceStats {
    constructor() {
        this.stats = {
            totalRequests: 0,
            cacheHits: 0,
            cacheMisses: 0,
            avgResponseTime: 0,
            responseTimeSum: 0,
            routeMatchTime: 0,
            headlessRoutes: 0,
            shopifyRoutes: 0,
            apiCollectRequests: 0,
            monorailRequests: 0,
            httpResponseCacheHits: 0,
            errors: 0
        };
        this.responseTimes = [];
    }
    
    recordRequest(duration, isCacheHit, isHeadless, routeMatchTime, isApiCollect = false, isMonorail = false, isHttpCacheHit = false) {
        this.stats.totalRequests++;
        this.stats.responseTimeSum += duration;
        this.stats.avgResponseTime = this.stats.responseTimeSum / this.stats.totalRequests;
        this.stats.routeMatchTime += routeMatchTime;
        
        if (isCacheHit) {
            this.stats.cacheHits++;
        } else {
            this.stats.cacheMisses++;
        }
        
        if (isHeadless) {
            this.stats.headlessRoutes++;
        } else {
            this.stats.shopifyRoutes++;
        }
        
        if (isApiCollect) {
            this.stats.apiCollectRequests++;
        }
        
        if (isMonorail) {
            this.stats.monorailRequests++;
        }
        
        if (isHttpCacheHit) {
            this.stats.httpResponseCacheHits++;
        }
        
        this.responseTimes.push(duration);
        if (this.responseTimes.length > 1000) {
            this.responseTimes.shift();
        }
    }
    
    recordError() {
        this.stats.errors++;
    }
    
    getCacheHitRate() {
        const total = this.stats.cacheHits + this.stats.cacheMisses;
        return total > 0 ? parseFloat((this.stats.cacheHits / total * 100).toFixed(2)) : 0;
    }
    
    getPercentile(p) {
        if (this.responseTimes.length === 0) return 0;
        const sorted = [...this.responseTimes].sort((a, b) => a - b);
        const index = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[index] || 0;
    }
    
    getReport() {
        return {
            ...this.stats,
            cacheHitRate: this.getCacheHitRate(),
            p95ResponseTime: this.getPercentile(95),
            p99ResponseTime: this.getPercentile(99),
            avgRouteMatchTime: this.stats.totalRequests > 0 ? 
                parseFloat((this.stats.routeMatchTime / this.stats.totalRequests).toFixed(2)) : 0
        };
    }
}

// 全局性能统计实例
const perfStats = new PerformanceStats();

// 缓存清理函数
function cleanCacheIfNeeded() {
    if (routeCache.size > MAX_CACHE_SIZE) {
        const keysToDelete = Array.from(routeCache.keys()).slice(0, Math.floor(MAX_CACHE_SIZE / 2));
        keysToDelete.forEach(key => routeCache.delete(key));
        console.log(`🧹 清理路由缓存，删除 ${keysToDelete.length} 个条目`);
    }
    
    // 清理过期的 API 收集缓存
    const now = Date.now();
    for (const [key, value] of apiCollectCache.entries()) {
        if (now - value.timestamp > API_COLLECT_CACHE_TTL * 1000) {
            apiCollectCache.delete(key);
        }
    }
    
    // 清理过期的 Monorail 缓存
    for (const [key, value] of monorailCache.entries()) {
        if (now - value.timestamp > MONORAIL_CACHE_TTL * 1000) {
            monorailCache.delete(key);
        }
    }
    
    // 清理过期的 HTTP 响应缓存
    for (const [key, value] of httpResponseCache.entries()) {
        if (now - value.timestamp > HTTP_RESPONSE_CACHE_TTL * 1000) {
            httpResponseCache.delete(key);
        }
    }
    
    // 限制 HTTP 响应缓存大小
    if (httpResponseCache.size > MAX_RESPONSE_CACHE_SIZE) {
        const keysToDelete = Array.from(httpResponseCache.keys()).slice(0, Math.floor(MAX_RESPONSE_CACHE_SIZE / 2));
        keysToDelete.forEach(key => httpResponseCache.delete(key));
        console.log(`🧹 清理HTTP响应缓存，删除 ${keysToDelete.length} 个条目`);
    }
}

/**
 * 高性能路由匹配函数 (带缓存和监控)
 * @param {string} path 请求路径
 */
function isHeadlessRouteWithMonitoring(path) {
    const routeStartTime = performance.now();
    
    // 1. 检查缓存 (最快)
    const cached = routeCache.get(path);
    if (cached !== undefined) {
        const routeEndTime = performance.now();
        const routeMatchTime = routeEndTime - routeStartTime;
        return { result: cached, isCacheHit: true, routeMatchTime };
    }
    
    let isHeadless = false;
    
    // 2. 精确匹配 (O(1))
    if (HEADLESS_ROUTES.exact.has(path)) {
        isHeadless = true;
    }
    // 3. 前缀匹配 (O(n)，但 n 很小且按长度排序)
    else {
        for (const prefix of HEADLESS_ROUTES.prefixes) {
            if (path.startsWith(prefix)) {
                isHeadless = true;
                break;
            }
        }
        
        // 4. 正则匹配 (最慢，最后执行)
        if (!isHeadless) {
            for (const pattern of HEADLESS_ROUTES.patterns) {
                if (pattern.test(path)) {
                    isHeadless = true;
                    break;
                }
            }
        }
    }
    
    // 缓存结果
    routeCache.set(path, isHeadless);
    
    const routeEndTime = performance.now();
    const routeMatchTime = routeEndTime - routeStartTime;
    
    return { result: isHeadless, isCacheHit: false, routeMatchTime };
}

/**
 * Shopify Monorail 接口优化处理
 */
async function handleMonorailOptimized(request, path) {
    const cacheKey = `monorail:${request.method}:${path}`;
    
    // 检查缓存
    const cached = monorailCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < MONORAIL_CACHE_TTL * 1000)) {
        console.log(`🚀 Monorail缓存命中: ${path}`);
        return new Response(cached.response, {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `public, max-age=${MONORAIL_CACHE_TTL}`,
                'X-Cache': 'HIT'
            }
        });
    }
    
    // Monorail 接口通常是 POST 请求，返回简单的成功响应
    if (request.method === 'POST') {
        const response = JSON.stringify({ 
            status: 'ok', 
            cached: true,
            timestamp: Date.now()
        });
        
        // 缓存响应
        monorailCache.set(cacheKey, {
            response,
            timestamp: Date.now()
        });
        
        console.log(`📊 Monorail优化处理: ${path}`);
        return new Response(response, {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `public, max-age=${MONORAIL_CACHE_TTL}`,
                'X-Cache': 'MISS'
            }
        });
    }
    
    return null; // 继续正常处理
}

/**
 * API 收集接口优化处理
 */
async function handleApiCollectOptimized(request, path) {
    const cacheKey = `${request.method}:${path}:${request.headers.get('user-agent') || ''}`;
    
    // 检查缓存
    const cached = apiCollectCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < API_COLLECT_CACHE_TTL * 1000)) {
        console.log(`🚀 API收集缓存命中: ${path}`);
        return new Response(cached.response, {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `public, max-age=${API_COLLECT_CACHE_TTL}`,
                'X-Cache': 'HIT'
            }
        });
    }
    
    // 如果是 POST 请求且数据量小，可以批量处理
    if (request.method === 'POST') {
        try {
            const body = await request.text();
            
            // 简单的数据验证和优化
            if (body.length < 1000) { // 小数据量直接返回成功
                const response = JSON.stringify({ status: 'success', cached: true });
                
                // 缓存响应
                apiCollectCache.set(cacheKey, {
                    response,
                    timestamp: Date.now()
                });
                
                return new Response(response, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Cache-Control': `public, max-age=${API_COLLECT_CACHE_TTL}`,
                        'X-Cache': 'MISS'
                    }
                });
            }
        } catch (error) {
            console.error('API收集请求处理错误:', error);
        }
    }
    
    return null; // 继续正常处理
}

// ===================================
// 3. 增强的主请求处理函数 (带性能监控和优化)
// ===================================

async function handleRequest(request) {
    const startTime = performance.now();
    
    // 定期清理缓存和输出统计
    requestCount++;
    if (requestCount % 100 === 0) {
        cleanCacheIfNeeded();
        
        // 每 100 个请求输出一次性能报告
        const report = perfStats.getReport();
        console.log('=== 🚀 性能报告 ===');
        console.log(`📊 总请求数: ${report.totalRequests}`);
        console.log(`⚡ 平均响应时间: ${report.avgResponseTime.toFixed(2)}ms`);
        console.log(`📈 P95响应时间: ${report.p95ResponseTime}ms`);
        console.log(`🎯 缓存命中率: ${report.cacheHitRate}%`);
        console.log(`🔍 平均路由匹配时间: ${report.avgRouteMatchTime}ms`);
        console.log(`📡 API收集请求: ${report.apiCollectRequests}`);
        console.log(`📊 Monorail请求: ${report.monorailRequests}`);
        console.log(`💾 HTTP缓存命中: ${report.httpResponseCacheHits}`);
        console.log(`🔄 路由分布: 无头${report.headlessRoutes} | Shopify${report.shopifyRoutes}`);
        console.log(`❌ 错误数: ${report.errors}`);
        console.log('==================');
    }
    
    try {
        const url = new URL(request.url);
        const path = url.pathname;
        
        // 特殊处理：性能报告端点
        if (path === '/__performance') {
            return handlePerformanceReport(request);
        }
        
        // 特殊优化：Shopify Monorail 接口
        const isMonorail = path.startsWith('/.well-known/shopify/monorail');
        if (isMonorail) {
            const optimizedResponse = await handleMonorailOptimized(request, path);
            if (optimizedResponse) {
                const endTime = performance.now();
                const duration = endTime - startTime;
                perfStats.recordRequest(duration, true, false, 0, false, true); // Shopify路由
                console.log(`📊 Monorail优化: ${path} - ${duration.toFixed(2)}ms`);
                return optimizedResponse;
            }
        }
        
        // 特殊优化：API 收集接口
        const isApiCollect = path.startsWith('/api/collect');
        if (isApiCollect) {
            const optimizedResponse = await handleApiCollectOptimized(request, path);
            if (optimizedResponse) {
                const endTime = performance.now();
                const duration = endTime - startTime;
                perfStats.recordRequest(duration, true, true, 0, true, false);
                console.log(`🚀 API收集优化: ${path} - ${duration.toFixed(2)}ms (缓存命中)`);
                return optimizedResponse;
            }
        }
        
        // 检查 HTTP 响应缓存
        const cacheKey = `${request.method}:${path}:${request.headers.get('accept') || ''}`;
        const cachedResponse = httpResponseCache.get(cacheKey);
        
        if (cachedResponse && (Date.now() - cachedResponse.timestamp < HTTP_RESPONSE_CACHE_TTL * 1000)) {
            const endTime = performance.now();
            const duration = endTime - startTime;
            perfStats.recordRequest(duration, true, false, 0, false, false, true);
            console.log(`🚀 HTTP缓存命中: ${path} - ${duration.toFixed(2)}ms`);
            
            return new Response(cachedResponse.body, {
                status: cachedResponse.status,
                headers: new Headers(cachedResponse.headers)
            });
        }
        
        // 性能优化：路由匹配 (带监控)
        const routeResult = isHeadlessRouteWithMonitoring(path);
        const isHeadless = routeResult.result;
        const targetOrigin = isHeadless ? HEADLESS_ORIGIN : SHOPIFY_ORIGIN;
        
        // 构造目标 URL
        const targetUrl = new URL(path + url.search, targetOrigin);
        
        // 优化：复用 headers，只修改必要的部分
        const headers = new Headers(request.headers);
        if (isHeadless) {
            headers.set('Host', new URL(HEADLESS_ORIGIN).host);
        } else {
            headers.set('Host', SHOPIFY_HOST_HEADER);
        }
        
        // 记录请求开始时间
        const fetchStartTime = performance.now();
        
        // 性能优化：减少对象创建，直接传递参数
        const response = await fetch(targetUrl.href, {
            method: request.method,
            headers: headers,
            body: request.body,
            redirect: 'follow'
        });
        
        const fetchEndTime = performance.now();
        const totalDuration = fetchEndTime - startTime;
        const fetchDuration = fetchEndTime - fetchStartTime;
        
        // 缓存 HTTP 响应 (仅缓存 GET 请求和成功响应)
        if (request.method === 'GET' && response.ok) {
            try {
                const responseBody = await response.text();
                const responseHeaders = {};
                response.headers.forEach((value, key) => {
                    responseHeaders[key] = value;
                });
                
                httpResponseCache.set(cacheKey, {
                    body: responseBody,
                    status: response.status,
                    headers: responseHeaders,
                    timestamp: Date.now()
                });
                
                console.log(`💾 缓存HTTP响应: ${path}`);
                
                // 重新创建 Response 对象返回
                const cachedResponse = new Response(responseBody, {
                    status: response.status,
                    headers: new Headers(responseHeaders)
                });
                
                // 记录性能统计
                perfStats.recordRequest(
                    totalDuration, 
                    routeResult.isCacheHit, 
                    isHeadless, 
                    routeResult.routeMatchTime,
                    isApiCollect,
                    isMonorail,
                    false
                );
                
                return cachedResponse;
            } catch (error) {
                console.warn('⚠️ 缓存HTTP响应失败:', error.message);
            }
        }
        
        // 记录性能统计
        perfStats.recordRequest(
            totalDuration, 
            routeResult.isCacheHit, 
            isHeadless, 
            routeResult.routeMatchTime,
            isApiCollect,
            isMonorail,
            false
        );
        
        // 性能日志
        const cacheStatus = routeResult.isCacheHit ? '🎯 HIT' : '❌ MISS';
        const targetType = isHeadless ? '🔥 HEADLESS' : '🛒 SHOPIFY';
        console.log(`✅ ${request.method} ${path} - 总时间:${totalDuration.toFixed(2)}ms | ` +
                   `路由:${routeResult.routeMatchTime.toFixed(2)}ms | ` +
                   `网络:${fetchDuration.toFixed(2)}ms | ` +
                   `缓存:${cacheStatus} | 目标:${targetType}`);
        
        return response;
        
    } catch (error) {
        const endTime = performance.now();
        const duration = endTime - startTime;
        
        perfStats.recordError();
        console.error(`❌ 请求失败 (${duration.toFixed(2)}ms):`, error.message);
        
        // 返回错误响应
        return new Response('Internal Server Error', {
            status: 500,
            headers: {
                'Content-Type': 'text/plain',
                'Cache-Control': 'no-cache'
            }
        });
    }
}

// 性能报告端点
async function handlePerformanceReport(request) {
    const report = perfStats.getReport();
    
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>🚀 Worker 性能监控</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f7fa; }
            .container { max-width: 1200px; margin: 0 auto; }
            .header { text-align: center; margin-bottom: 30px; }
            .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
            .metric { padding: 20px; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            .metric h3 { margin: 0 0 10px 0; color: #2c3e50; }
            .metric .value { font-size: 24px; font-weight: bold; margin: 10px 0; }
            .good { border-left: 4px solid #27ae60; }
            .warning { border-left: 4px solid #f39c12; }
            .danger { border-left: 4px solid #e74c3c; }
            .refresh { position: fixed; top: 20px; right: 20px; }
            .btn { background: #3498db; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🚀 Cloudflare Worker 性能监控</h1>
                <p>实时性能指标和优化效果监控</p>
            </div>
            
            <div class="metrics">
                <div class="metric ${report.avgResponseTime < 100 ? 'good' : report.avgResponseTime < 200 ? 'warning' : 'danger'}">
                    <h3>⚡ 平均响应时间</h3>
                    <div class="value">${report.avgResponseTime.toFixed(2)}ms</div>
                    <small>P95: ${report.p95ResponseTime}ms | P99: ${report.p99ResponseTime}ms</small>
                </div>
                
                <div class="metric ${report.cacheHitRate > 80 ? 'good' : report.cacheHitRate > 50 ? 'warning' : 'danger'}">
                    <h3>🎯 缓存命中率</h3>
                    <div class="value">${report.cacheHitRate.toFixed(2)}%</div>
                    <small>命中: ${report.cacheHits} | 未命中: ${report.cacheMisses}</small>
                </div>
                
                <div class="metric good">
                    <h3>📊 请求统计</h3>
                    <div class="value">${report.totalRequests}</div>
                    <small>总请求数</small>
                </div>
                
                <div class="metric">
                    <h3>🔍 路由性能</h3>
                    <div class="value">${report.avgRouteMatchTime.toFixed(2)}ms</div>
                    <small>平均路由匹配时间</small>
                </div>
                
                <div class="metric">
                    <h3>📡 API 收集优化</h3>
                    <div class="value">${report.apiCollectRequests}</div>
                    <small>API收集请求数</small>
                </div>
                
                <div class="metric">
                    <h3>📊 Monorail 优化</h3>
                    <div class="value">${report.monorailRequests}</div>
                    <small>Shopify数据收集请求</small>
                </div>
                
                <div class="metric">
                    <h3>🔄 路由分布</h3>
                    <div class="value">${report.headlessRoutes} / ${report.shopifyRoutes}</div>
                    <small>无头路由 / Shopify路由</small>
                </div>
                
                <div class="metric ${report.errors === 0 ? 'good' : 'danger'}">
                    <h3>❌ 错误监控</h3>
                    <div class="value">${report.errors}</div>
                    <small>错误请求数</small>
                </div>
            </div>
            
            <div style="margin-top: 30px; text-align: center; color: #7f8c8d;">
                <p>最后更新: ${new Date().toLocaleString('zh-CN')}</p>
                <p>访问 <code>/__performance</code> 查看实时性能报告</p>
            </div>
        </div>
        
        <button class="btn refresh" onclick="location.reload()">🔄 刷新</button>
        
        <script>
            // 每30秒自动刷新
            setTimeout(() => location.reload(), 30000);
        </script>
    </body>
    </html>`;
    
    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

// ===================================
// 4. 事件监听器 - 放在文件最末尾
// ===================================

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});