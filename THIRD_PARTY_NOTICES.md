# 第三方代码与资料出处

本项目的自有代码以 MIT 发布（见 `LICENSE`）。下面这些是**别人的东西**，按各自许可证使用。

## 代码

| 位置 | 来源 | 许可证 | 说明 |
|---|---|---|---|
| `vendor/cuktech_ble/xiaomi_cloud.py` | [PiotrMachowski/Xiaomi-cloud-tokens-extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor) | **MIT** | 小米云登录（扫码/设备列表）流程改编自该项目。原文：`Adapted from https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor.` |
| `vendor/koffi` | [Koffi](https://koffi.dev/) | **MIT** | 随包携带，用于从 Node 调 Win32 API（隐藏控制台窗口、无边框窗口）。 |
| `vendor/ca/xiaomi-roots.pem` | 微软信任库里的公共根证书 | 公共证书 | 只含 GoDaddy Root CA - G2 的证书本体（无任何私钥）。 |

`vendor/miio_lan.py`、`vendor/cuktech_ble/*`（除上面那一处）是按公开的协议文档
（miIO 局域网协议、MIOT over BLE、小米 BLE 广播）自己实现的，未直接复制第三方代码。

### MIT 许可证原文（对上面两项生效）

```
MIT License

Copyright (c) 2020 Piotr Machowski          (Xiaomi-cloud-tokens-extractor)
Copyright (c) Koffi contributors            (Koffi)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 资料（只参考了结论，没有复制代码）

- 官方规格表：`home.miot-spec.com/spec/njcuk.fitting.ad1204`
- 小米 IoT 开发者平台关于 BLE / BLE Mesh 设备控制的问答（`iot.mi.com`）
- 社区里对 AD1204U 的第三方实现（`cuktech-ble-server`、`cuktech-ble-controller`、`ha-cuk-ble`）：
  用来交叉核对**位定义与枚举取值**，其中几处结论在本仓库里有标注（属性 2.6 / 2.21 等）。

## 明确不包含的东西

本仓库**不包含**、也不分发：

- 米家 App 的任何代码或其反编译产物
- 充电头固件镜像（`.bin` / `.elf` / `.pe`）
- 任何设备的 BLE 密钥、token 或用电历史（`.gitignore` 已排除 `data/`）

## 商标

“CUKTECH / 酷态科”“小米 / Xiaomi / 米家”是其各自权利人的商标。
本项目为非官方的第三方工具，未获授权、也不代表其立场。
