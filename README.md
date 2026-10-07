# 中国联通余量 · Egern 小组件

在 iOS 主屏幕或锁屏上显示中国联通号码的话费、语音和流量余量。流量按通用和定向（免流）分开，每类都显示剩余、已用和总量。

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

| 尺寸 | 内容 |
| --- | --- |
| 小号 | 话费、语音，通用和定向流量的剩余/总量及比例条 |
| 中号 | 话费、语音；右侧是通用和定向流量：剩余、比例条、已用、总量 |
| 大号 | 套餐名，话费/语音/流量三项，通用和定向明细，前几个流量包 |
| 锁屏 | 圆形显示通用剩余（没有通用流量包时显示话费）；矩形和单行显示话费加流量剩余 |

- 比例条表示剩余占总量的比例，低于 20% 变橙色，低于 10% 变红色。
- 不限量的流量包只计入已用量，不计入剩余和总量；如果有，总量后面会标「含不限」。
- 右上角是数据的更新时间（北京时间）。查询失败时，时间前面会出现警示图标，显示的是上次成功查到的数据。

## 设置

在 工具 → 模块 → 本模块 的 Env 中设置：

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `TITLE` | 左上角标题，最多 12 个字 | 中国联通 |
| `SHOW_PHONE_SUFFIX` | 在标题旁显示号码后四位 | false |
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
