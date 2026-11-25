# Changelog

## [0.2.0](https://github.com/hampusadamsson/kb/compare/v0.1.0...v0.2.0) (2026-11-25)


### Features

* **automation:** run scheduled automations from web and mcp ([9d40964](https://github.com/hampusadamsson/kb/commit/9d4096483f553ce68cdfe07ac2d517f644b08caf))
* **build:** standalone binary (Node SEA) and installable artifacts workflow ([05b755e](https://github.com/hampusadamsson/kb/commit/05b755e2f28fbee44847058f47001fe8cc760e76))
* **config:** derive ticket ids from the file name ([9d7067d](https://github.com/hampusadamsson/kb/commit/9d7067d3969aafe49efc54fe540613b7210977c7))
* **core:** add cron parser and schedule trigger config ([3d12add](https://github.com/hampusadamsson/kb/commit/3d12add93c008cf28879f5811a8d6e18f2191d81))
* **mcp:** add kb mcp stdio server ([ebd8e5e](https://github.com/hampusadamsson/kb/commit/ebd8e5e97645b922a296074b56612efb13fd82b2))
* **mcp:** serve mcp over http and add a container image ([#16](https://github.com/hampusadamsson/kb/issues/16)) ([d34abe6](https://github.com/hampusadamsson/kb/commit/d34abe6fc20c2e3a0fa3b768a57aa85655183d02))
* v2 ([563f09a](https://github.com/hampusadamsson/kb/commit/563f09a6c639b853547923eb99703114b6afd021))
* **web:** collapse and filter card properties ([5479d73](https://github.com/hampusadamsson/kb/commit/5479d7309cb0bfea836e80c0f5f169336a3de223))
* **web:** collapse ticket metadata in the dialog ([0549b2b](https://github.com/hampusadamsson/kb/commit/0549b2b5c4caab22cb6be7fadb379b94a78b3bb3))
* **web:** confirm before deleting an automation ([25580e1](https://github.com/hampusadamsson/kb/commit/25580e1f6d94768e428324946dd4b7c16c93b2b1))


### Bug Fixes

* address review findings across cli, core, web, api, mcp and process control ([#7](https://github.com/hampusadamsson/kb/issues/7)) ([d0c4f41](https://github.com/hampusadamsson/kb/commit/d0c4f41b7543d7d680a5fef4fb18307b42bbfe42))
* bound the remaining blocking ps call and harden the mcp transport ([4b849e3](https://github.com/hampusadamsson/kb/commit/4b849e311c0b86fa3c188a362be37ffcf7e884c8))
* **ci:** chain publish after release-please instead of tag trigger ([b03e4e4](https://github.com/hampusadamsson/kb/commit/b03e4e41430d572cb6b802c2bc170437c6f6f286))
* **core:** stop treating EPERM as a dead pid and keep completion spaces intact ([dd7a6a5](https://github.com/hampusadamsson/kb/commit/dd7a6a5724339411b934f9026f7f72fea1d9a323))
* **core:** widen board validation and share the glob schema with the save path ([#8](https://github.com/hampusadamsson/kb/issues/8)) ([af4b8a0](https://github.com/hampusadamsson/kb/commit/af4b8a038cebef441ff4cc97f1f71bde07509130))
* id example ([cb7842d](https://github.com/hampusadamsson/kb/commit/cb7842d09722fd483124d8cc0d21b3e50bb7134e))
* web ([580a525](https://github.com/hampusadamsson/kb/commit/580a525eb9c584232361e089cea4f2eed5846ad3))


### Refactors

* **api:** move ui-agnostic api layer out of src/web ([31bee76](https://github.com/hampusadamsson/kb/commit/31bee767b5f13511f243dc1c351d966960bb12b2))
* **automation:** replace KB_AUTOMATION with depth limit and re-entrancy lock ([e912f15](https://github.com/hampusadamsson/kb/commit/e912f15f7d38ff0db2f36ff3abbbd4989553e4d2))
* **web:** make the board much more compact ([a153395](https://github.com/hampusadamsson/kb/commit/a15339596e76bb9400a79c413cfc63550eca4982))


### Documentation

* document the schedule trigger ([6f7d146](https://github.com/hampusadamsson/kb/commit/6f7d146bac6f939c022bb2a9404f5e1e5501a592))
* explain how to operate the schedule trigger ([af202bf](https://github.com/hampusadamsson/kb/commit/af202bf52c21fb4a79dfe230d3e762eb7908f489))
* explain which files count as tickets ([91025b0](https://github.com/hampusadamsson/kb/commit/91025b0e1c634936e1c2b6d250966eb5c41c72dd))
* **mcp:** document kb mcp and its tools ([1b6b5cb](https://github.com/hampusadamsson/kb/commit/1b6b5cb0d53a5a9353d559f1015cce2c59301b55))
* **readme:** add screenshot at the top, centered ([d1227ad](https://github.com/hampusadamsson/kb/commit/d1227ad97bbf1377ac94deb2b32fbec300ca6a8d))
