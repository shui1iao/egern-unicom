# 中国联通余量 · Egern 小组件

在 iOS 主屏幕或锁屏上显示中国联通号码的话费、流量和语音余量。

## 安装

1. 打开 Egern，进入 工具 → 模块，点右上角 `+`，填入模块地址：

   ```
   https://raw.githubusercontent.com/shui1iao/egern-unicom/main/unicom.yaml
   ```

2. 确认 MITM 已开启，Egern 的 CA 证书已安装并信任。模块会自动加入 `m.client.10010.com` 和 `loginxhm.10010.com`。
3. 从后台划掉联通 App，再重新打开，在首页查一次余额。收到「登录信息已就绪」通知就说明设置好了。
4. 长按主屏幕空白处，点 `+`，搜索 Egern 并选择尺寸。添加后长按小组件 → 编辑小组件，选择「中国联通余量」。

第 3 步里，App 冷启动时会自动登录，脚本借此记下续登用的 `token_online`；在首页查余额则会记下 Cookie 和手机号。如果只收到「已获取登录信息」通知，说明这次没有拦到自动登录，再划掉 App 重开一次即可。

## 显示内容

样式参照 [anker1209/Scriptable](https://github.com/anker1209/Scriptable) 的中国联通小组件（原作者：脑瓜），显示代码按 Egern 小组件格式重新实现。话费红、流量蓝、语音橙，每项一块同色淡底的圆角格。

| 尺寸 | 排列 |
| --- | --- |
| 小号 | 三行横条：话费、流量、语音，左边名称和剩余量，右边图标 |
| 中号 | 三格一排：话费格是 ¥ 图标和更新时间；流量、语音格是圆环，圈里是剩余百分比，下面是剩余量和名称 |
| 大号 | 上面一条话费横条（含更新时间），下面流量和语音两个大圆环格 |
| 锁屏 | 圆形显示流量剩余和进度环；矩形三行显示话费、流量、语音；单行是「¥话费 · 流量 · 语音」 |

- 流量不分通用和定向，合在一起算剩余和总量。不限量的流量包只计入已用量，不计入剩余和总量。
- 圆环表示剩余占总量的比例，低于 20% 变橙色，低于 10% 变红色。拿不到总量时画满一圈，圈里只放图标。
- 话费低于提醒线时数字变红，名称改为「余额不足」。
- 查询失败时，更新时间的位置换成警示图标和上次成功查到的时间；登录失效时显示「需登录」。

## 设置

在 工具 → 模块 → 本模块 的 Env 中设置：

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `LOW_FEE` | 话费低于这个数（元）时标红，填 0 关闭 | 10 |

## 登录过期

- Cookie 过期后，小组件会用 `token_online` 自动续登，然后重新查询，不需要任何操作。
- 只有续登也失败时（例如在别的设备登录过，或者联通要求短信验证），小组件才会提示「需重新登录」。这时打开联通 App 正常登录并查一次余额就会恢复。
- 登录失效后的 1 小时内，小组件不会再用旧凭据反复请求。

## 数据与隐私

- Cookie、手机号、`token_online` 和 `appId` 只保存在本机 Egern 的脚本存储里，只发往联通自己的接口（`m.client.10010.com`），不经过任何第三方服务器。
- 小组件上不显示完整手机号。
- 拦截联通 App 的请求时，脚本只读取数据，不修改请求和响应。

## 数据来源

| 接口 | 用途 |
| --- | --- |
| `mobileserviceimportant/home/queryUserInfoSeven` | 话费、语音、流量三个总数（与联通 App 首页一致） |
| `servicequerybusiness/operationservice/queryOcsPackageFlowLeftContentRevisedInJune` | 各流量包的已用、剩余、总量 |
| `mobileService/onLine.htm` | 用 `token_online` 换新 Cookie |

接口用法参考了 [IBL3ND/module](https://github.com/IBL3ND/module) 的联通小组件和 [pangpangyunshu/ChinaUnicom](https://github.com/pangpangyunshu/ChinaUnicom)。联通随时可能调整接口；如果某天数据显示不出来，多半是接口变了。

## 开发

```
npm test
```

测试用模拟的 Egern 运行时（`ctx.http`、`ctx.storage`、`ctx.notify`）覆盖抓取、续登、缓存、异常输入，并按 [Egern 小组件文档](https://egernapp.com/zh-CN/docs/configuration/widgets) 检查每个尺寸输出的 DSL。测试不会访问真实的联通接口。
