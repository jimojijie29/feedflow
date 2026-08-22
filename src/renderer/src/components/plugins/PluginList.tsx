import { useState } from 'react'
import { useStore } from '../../store'
import { EmptyState } from '../common/EmptyState'
import styles from './PluginList.module.css'

export function PluginList(): JSX.Element {
  const { plugins, pluginsLoading, installPlugin, removePlugin } = useStore()
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleInstall = async () => {
    setError(null)
    setInstalling(true)
    try {
      await installPlugin()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 用户取消选择不算错误
      if (msg.includes('取消')) return
      setError(msg)
    } finally {
      setInstalling(false)
    }
  }

  const handleRemove = async (pluginId: string, pluginName: string) => {
    if (!window.confirm(`确定要删除插件「${pluginName}」吗？\n该插件的所有信息源和数据也会被一并删除。`)) {
      return
    }
    setError(null)
    try {
      await removePlugin(pluginId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (pluginsLoading) {
    return <div style={{ padding: 'var(--spacing-sm) var(--spacing-md)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>Loading...</div>
  }

  return (
    <div>
      <div className={styles.toolbar}>
        <button
          className={styles.installBtn}
          onClick={handleInstall}
          disabled={installing}
        >
          {installing ? '安装中...' : '＋ 安装插件'}
        </button>
      </div>

      {error && (
        <div className={styles.error}>安装失败：{error}</div>
      )}

      {plugins.length === 0 ? (
        <EmptyState
          icon="🔌"
          title="暂无插件"
          description="点击上方按钮上传 zip 压缩包安装插件"
        />
      ) : (
        <div className={styles.list}>
          {plugins.map((plugin) => {
            const isUser = plugin.source === 'user'
            return (
              <div key={plugin.id} className={styles.item}>
                <span className={styles.icon}>{plugin.icon ?? '📡'}</span>
                <div className={styles.info}>
                  <span className={styles.name}>{plugin.name}</span>
                  <span className={styles.version}>v{plugin.version}</span>
                </div>
                <span className={`${styles.badge} ${isUser ? styles.badgeUser : styles.badgeBuiltin}`}>
                  {isUser ? '用户安装' : '内置'}
                </span>
                {isUser && (
                  <button
                    className={styles.deleteBtn}
                    onClick={() => handleRemove(plugin.id, plugin.name)}
                    title="删除插件"
                  >
                    🗑
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
