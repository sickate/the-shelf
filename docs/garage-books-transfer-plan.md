# 暂停检查点与 Garage 书籍复制计划（2026-10-24）

用户已暂停长期开发目标；不执行finish-install、seed、Cloudflare发布/启用、业务PUT或AI。当前代码e7a9e05已push，两CI40092634503/40092634591成功，本机2352项Node+8项Python通过；生产仍为独立核验的disabled静态版本，auth2/0，013精确prefix6+3锁，原unknown/claim全部保留。下一次开发从固定finish-install开始，不能重跑原install。

本次目标：记录真实暂停点并push GitHub；另按用户明确要求，将本地书籍全集复制到garage:~/code/the-shelf/books。此SSH复制不等于网站或R2上传，也不启用在线阅读。只复制私人manifest所指书籍收藏源，凭证、数据库、.local收据及系统隐藏元数据不混入书籍目录。

分工：主Agent负责范围、目标/容量/SSH核验、实际传输与最终hash验收；progress_checkpoint（gpt-6-luna/medium）更新development-plan/task-status/resources三份暂停记录，不含私人路径/文件名；transfer_inventory（gpt-6.1-sol/high）只读核对manifest源、全集文件类型/数量/bytes与符号链接，准备0700/0600私有相对路径+大小+SHA256清单，给出安全rsync参数，不访问网络或写源书。主Agent独立review。

步骤及依赖：先盘点本地完整源（含未进入旧manifest的书），核对SSH目标确为用户指定Garage及项目路径、目标可用空间；不删除任何本地或远端文件。保留源相对目录和Unicode文件名；已有同路径同内容跳过，冲突先保留目标旧版本到本项目专用备份目录再写入；禁止--delete及向公开站点/第三方发送。可用rsync续传普通文件，此处不套用R2唯一PUT规则。传输后独立对远端同一固定清单核对文件数/bytes/全文SHA256，并确认本地源未漂移。失败保留部分文件/临时记录，可在同一SSH目标安全续传；不释放/改写云端责任。

验收及交付：私有清单/收据不入Git；文档只记录数量、字节、hash验收、代码/CI/线上区分和具体下一步。主Agent审阅文档、diff检查和实际凭证扫描后commit→push并确认远端SHA；本次无产品实现变更，无需重跑全量测试或部署。复制完成后以真实统计报告，长期开发目标保持paused。

## 本次执行记录

进度文档检查点已提交752a50b并经git ls-remote确认GitHub main一致；两条文档CI（40093428303、40093428318）均已成功；本次未部署生产。公开文档导出、verify:public及实际配置秘密扫描1644文件零命中通过。

Garage书籍全集盘点为3657文件、15,067,525,579 bytes（约14.03 GiB），排除39项数据库、程序或系统元数据；复制正在进行，尚未完成远端全文SHA256验收。链路约0.3 MB/s，预计可能耗时十余小时；最终以私有传输收据为准。本地逐文件SHA256及两次源stat复核通过；Garage目标与备份目录无symlink，目标可用空间约97 GB。使用原生rsync固定NUL清单与checksum，不删除，远端冲突保留到项目私有备份。

传输收据与验收脚本仅保存于被忽略的.local/garage-transfer-20261024/，不提交书籍路径/文件名/内容。后台runner在复制后依次执行本地源stat、远端逐文件全文SHA256、本地末次stat，只有三步全部通过才写success收据；失败保留文件和责任、记failed或blocked。当前尚无success验收收据，不能称全量已上传。无Cloudflare写入、AI调用或生产部署。
