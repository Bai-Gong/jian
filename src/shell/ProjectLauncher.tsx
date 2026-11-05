import { isTauri } from "@tauri-apps/api/core";
import { ArrowUpRight, Clapperboard, Clock3, FileVideo, FolderOpen, Plus, X } from "lucide-react";
import { useProjectSession } from "../core/project/projectSession";
import { useRecentProjects } from "../core/project/recentProjects";
import "./project-launcher.css";

const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai",
});

export function ProjectLauncher() {
  const busy = useProjectSession(s => s.busy);
  const recentProjects = useRecentProjects(s => s.recentProjects);
  const desktop = isTauri();
  return <main className="project-launcher" aria-label="项目选择">
    <div className="project-launcher__content">
      <header className="project-launcher__heading">
        <span className="project-launcher__mark"><Clapperboard size={28} strokeWidth={1.4} /></span>
        <p className="project-launcher__eyebrow">百工 · 剪</p>
        <h1>开始下一段故事</h1>
        <p>创建新项目，或继续上次的剪辑。</p>
      </header>
      <div className="project-launcher__actions">
        <button type="button" className="project-launcher__action fang-glass-surface" disabled={busy} onClick={() => void useProjectSession.getState().newProject()}>
          <span className="project-launcher__action-icon"><Plus size={23} /></span>
          <span><strong>新建项目</strong><small>从一条空白时间线开始</small></span>
          <ArrowUpRight size={18} />
        </button>
        <button type="button" className="project-launcher__action fang-glass-surface" disabled={busy || !desktop} onClick={() => void useProjectSession.getState().openProject()}>
          <span className="project-launcher__action-icon"><FolderOpen size={23} /></span>
          <span><strong>打开项目</strong><small>选择已有的 .jian 项目文件</small></span>
          <ArrowUpRight size={18} />
        </button>
      </div>
      <section className="project-launcher__recent" aria-labelledby="recent-projects-heading">
        <header><h2 id="recent-projects-heading">最近项目</h2><span>{recentProjects.length > 0 ? `${recentProjects.length} 个项目` : "你的剪辑，从这里继续"}</span></header>
        <div className="project-launcher__list fang-glass-surface" aria-busy={busy}>
          {recentProjects.length === 0 ? <div className="project-launcher__empty">
            <Clock3 size={28} strokeWidth={1.3} />
            <strong>还没有最近项目</strong>
            <p>打开或保存的项目会显示在这里。</p>
          </div> : recentProjects.map(project => <div className="project-launcher__row" key={project.path}>
            <button type="button" className="project-launcher__open" disabled={busy || !desktop} onClick={() => void useProjectSession.getState().openProject(project.path)} title={project.path}>
              <span className="project-launcher__file"><FileVideo size={20} strokeWidth={1.5} /></span>
              <span className="project-launcher__identity"><strong>{project.name}</strong><small>{project.path}</small></span>
              <time dateTime={new Date(project.lastOpenedAt).toISOString()}>{dateFormat.format(project.lastOpenedAt)}</time>
            </button>
            <button type="button" className="project-launcher__remove" disabled={busy} aria-label={`从最近项目移除 ${project.name}`} title="仅移除记录，不删除项目文件" onClick={() => useRecentProjects.getState().removeRecent(project.path)}><X size={15} /></button>
          </div>)}
        </div>
      </section>
      <footer className="project-launcher__footer"><span>{busy ? "正在处理项目…" : "项目文件记录素材位置，请保留原素材。"}</span>{!desktop && <span>打开本地项目请使用桌面应用</span>}</footer>
    </div>
  </main>;
}
