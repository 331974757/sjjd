// pages/events-hub/events-hub.js

/**
 * 赛事专区页 — 按游戏分类展示赛事入口
 * 设计为可扩展：新增游戏只需在 gameList 添加条目即可
 */
Page({
  data: {
    loading: false,

    /**
     * 游戏列表 — 每个条目对应一个游戏赛事专区
     * 新增游戏只需在此数组添加对象：
     *   { id, name, icon, desc, navigateTo, actions: [{key, icon, label, subTab}] }
     */
    gameList: [
      {
        id: 'dota2',
        name: 'Dota 2',
        icon: '🛡️',
        desc: '赛事对战、选手档案、队伍管理',
        // 点击卡片整体跳转：切到 dota2 Tab → 赛事章程（进行中赛事）
        navigateTo: { tab: 'dota2', subTab: 'rules' },
        actions: [
          { key: 'active',   icon: '🏆', label: '正在赛事', subTab: 'rules' },
          { key: 'history',  icon: '📋', label: '历史赛事', subTab: 'history' },
          { key: 'players',  icon: '👤', label: '选手档案', subTab: 'profile' },
          { key: 'rules',    icon: '📜', label: '赛事章程', subTab: 'rules' }
        ]
      }
    ]
  },

  onLoad() {
    // 预留：以后可从后端拉取游戏列表
  },

  onActionTap(e) {
    const gameId = e.currentTarget.dataset.gameId
    const actionKey = e.currentTarget.dataset.action
    const game = this.data.gameList.find(g => g.id === gameId)
    if (!game) return
    const act = game.actions.find(a => a.key === actionKey)
    if (!act) return
    this._jumpToGame(game.navigateTo.tab, act.subTab)
  },

  /**
   * 跳转到 dota2 页面并切换到指定子 Tab
   * 利用页面栈找到 dota2 页，设置 data 后返回
   */
  _jumpToGame(tab, subTab) {
    const pages = getCurrentPages()
    const indexPage = pages.find(p => p.route === 'pages/index/index')
    if (indexPage) {
      indexPage.setData({ currentGame: tab, subTab: subTab }, () => {
        // setData 完成后刷新数据
        if (subTab === 'rules') indexPage.loadRuleEvents()
        else if (subTab === 'history') indexPage.loadEvents()
      })
      wx.navigateBack()
    } else {
      wx.redirectTo({ url: `/pages/index/index?subTab=${subTab}` })
    }
  }
})
