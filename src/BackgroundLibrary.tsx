import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FolderOpen, ImagePlus, KeyRound, Search, Star, Trash2, X } from "lucide-react";
import { t, useLanguage } from "./i18n";
import { WALLPAPERS, wallpaperURL } from "./core/wallpapers";
import type { BackgroundKind } from "./types";
import "./background-library.css";

export interface BackgroundPhoto {
  id: string; description: string | null; altDescription: string | null; width: number; height: number; color: string | null;
  urls: { raw: string; full: string; regular: string; small: string; thumb: string };
  links: { html: string; downloadLocation: string };
  photographer: { name: string; username: string; profileURL: string };
}
export interface BackgroundSearchResult { query: string; page: number; total: number; totalPages: number; photos: BackgroundPhoto[]; omitted: number; rateLimitRemaining: number | null }
export interface ImportedBackground { path: string; photo: BackgroundPhoto; sha256: string; downloadURL: string; downloadedAt: string }
export interface BackgroundImageSource { sha256: string; downloadURL?: string; downloadedAt?: string }
interface FavoriteBase { id: string; name: string; createdAt: string }
export type BackgroundFavorite = FavoriteBase & (
  { kind: "wallpaper"; wallpaperId: number; wallpaperFile: string } |
  ({ kind: "image"; path: string; sourcePath?: string; photo?: BackgroundPhoto } & BackgroundImageSource)
);
export type BackgroundFavoriteInput = { kind: "wallpaper"; wallpaperId: number; name?: string } | { kind: "image"; path: string; name?: string; photo?: BackgroundPhoto; downloadURL?: string; downloadedAt?: string };
export type BackgroundSelection = { kind: "wallpaper"; wallpaperId: number } | { kind: "image"; path: string; photo?: BackgroundPhoto; sha256?: string; downloadURL?: string; downloadedAt?: string };
export interface BackgroundLibraryServices {
  importImage(): Promise<string | null>;
  search(query: string, page: number, accessKey: string): Promise<BackgroundSearchResult>;
  importPhoto(photo: BackgroundPhoto, accessKey: string): Promise<ImportedBackground>;
  listFavorites(): Promise<{ favorites: BackgroundFavorite[]; issues: { file: string; message: string }[] }>;
  saveFavorite(input: BackgroundFavoriteInput): Promise<BackgroundFavorite>;
  removeFavorite(id: string): Promise<void>;
  reveal(path: string): Promise<void>;
  openURL(url: string): Promise<void>;
  mediaURL(path: string): string;
}
export interface BackgroundLibraryProps {
  current: { kind: BackgroundKind; wallpaperId: number; imagePath: string | null; photo?: BackgroundPhoto; imageSource?: BackgroundImageSource };
  onSelect(selection: BackgroundSelection): void;
  services?: BackgroundLibraryServices;
  notify(message: string): void;
}
function referral(value: string): string {
  const url = new URL(value); url.searchParams.set("utm_source", "reva_studio"); url.searchParams.set("utm_medium", "referral"); return url.href;
}

export default function BackgroundLibrary({ current, onSelect, services, notify }: BackgroundLibraryProps) {
  useLanguage();
  const [tab, setTab] = useState<"favorites" | "unsplash">("favorites");
  const [favorites, setFavorites] = useState<BackgroundFavorite[]>([]), [issues, setIssues] = useState<{ file: string; message: string }[]>([]);
  const [query, setQuery] = useState(""), [key, setKey] = useState(""), [result, setResult] = useState<BackgroundSearchResult | null>(null);
  const [searching, setSearching] = useState(false), [pending, setPending] = useState<string | null>(null);
  const [loadingFavorites, setLoadingFavorites] = useState(false);
  const [favoritePage, setFavoritePage] = useState(0);
  const alive = useRef(true), request = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; }; }, []);
  const report = (error: unknown) => notify(error instanceof Error ? error.message : String(error));
  const refreshFavorites = async () => {
    if (!services) return;
    setLoadingFavorites(true);
    try { const list = await services.listFavorites(); if (alive.current) { setFavorites(list.favorites); setIssues(list.issues); } }
    catch (error) { if (alive.current) report(error); }
    finally { if (alive.current) setLoadingFavorites(false); }
  };
  useEffect(() => { void refreshFavorites(); }, [services]);
  const search = async (page = 1, term = query) => {
    if (!services || !key.trim() || !term.trim() || pending) return;
    const generation = ++request.current; setSearching(true);
    try { const found = await services.search(term, page, key); if (alive.current && request.current === generation) setResult(found); }
    catch (error) { if (alive.current && request.current === generation) report(error); }
    finally { if (alive.current && request.current === generation) setSearching(false); }
  };
  const choosePhoto = async (photo: BackgroundPhoto, favorite = false) => {
    if (!services || !key.trim() || pending) return;
    setPending(photo.id);
    try {
      const asset = await services.importPhoto(photo, key);
      if (!alive.current) return;
      onSelect({ kind: "image", ...asset });
      if (favorite) { await services.saveFavorite({ kind: "image", path: asset.path, name: photo.description || photo.altDescription || t("Photo by {name}", { name: photo.photographer.name }), photo, downloadURL: asset.downloadURL, downloadedAt: asset.downloadedAt }); await refreshFavorites(); }
    } catch (error) { if (alive.current) report(error); }
    finally { if (alive.current) setPending(null); }
  };
  const importLocal = async () => {
    if (!services || pending) return;
    setPending("local-import");
    try {
      const selected = await services.importImage(); if (!selected || !alive.current) return;
      const favorite = await services.saveFavorite({ kind: "image", path: selected });
      if (alive.current && favorite.kind === "image") { onSelect({ kind: "image", path: favorite.path, sha256: favorite.sha256, photo: favorite.photo }); await refreshFavorites(); }
    } catch (error) { if (alive.current) report(error); }
    finally { if (alive.current) setPending(null); }
  };
  const favoriteCurrent = async () => {
    if (!services || pending) return;
    setPending("favorite-current");
    try {
      if (current.kind === "wallpaper") await services.saveFavorite({ kind: "wallpaper", wallpaperId: current.wallpaperId });
      else if (current.kind === "image" && current.imagePath) await services.saveFavorite({ kind: "image", path: current.imagePath, photo: current.photo,
        downloadURL: current.imageSource?.downloadURL, downloadedAt: current.imageSource?.downloadedAt,
        ...(current.photo ? { name: current.photo.description || current.photo.altDescription || t("Photo by {name}", { name: current.photo.photographer.name }) } : {}) });
      await refreshFavorites();
    } catch (error) { if (alive.current) report(error); }
    finally { if (alive.current) setPending(null); }
  };
  const remove = async (favorite: BackgroundFavorite) => {
    if (!services || pending) return;
    setPending(favorite.id);
    try { await services.removeFavorite(favorite.id); await refreshFavorites(); }
    catch (error) { if (alive.current) report(error); }
    finally { if (alive.current) setPending(null); }
  };
  const link = (url: string) => { void services?.openURL(referral(url)).catch(report); };
  const attribution = (photo: BackgroundPhoto) => <div className="background-attribution">{t("Photo by")} <button onClick={() => link(photo.photographer.profileURL)}>{photo.photographer.name}</button> {t("on")} <button onClick={() => link("https://unsplash.com")}>Unsplash</button></div>;
  const selectedFavorite = favorites.find(favorite => favorite.kind === "wallpaper"
    ? current.kind === "wallpaper" && WALLPAPERS[current.wallpaperId]?.file === favorite.wallpaperFile
    : current.kind === "image" && current.imagePath === favorite.path && (current.photo?.id ?? null) === (favorite.photo?.id ?? null));
  const favoritePages = Math.max(1, Math.ceil(favorites.length / 50)), shownFavoritePage = Math.min(favoritePage, favoritePages - 1);
  return <section className="background-library" aria-label={t("Background library")}>
    <div className="background-library-tabs" role="tablist" aria-label={t("Background library source")}>
      <button role="tab" aria-selected={tab === "favorites"} onClick={() => setTab("favorites")}><Star size={13} />{t("Favorites")}</button>
      <button role="tab" aria-selected={tab === "unsplash"} onClick={() => setTab("unsplash")}>Unsplash</button>
    </div>
    {tab === "favorites" ? <div className="background-favorites" role="tabpanel">
      <div className="background-library-actions"><button className="outline-button" disabled={!services || !!pending} onClick={() => { void importLocal(); }}><ImagePlus size={13} />{t("Add local image")}</button><button className="outline-button" disabled={!services || !!pending || !!selectedFavorite || !(current.kind === "wallpaper" || current.kind === "image" && current.imagePath)} onClick={() => { void favoriteCurrent(); }}><Star size={13} />{t(selectedFavorite ? "Saved" : "Favorite current")}</button></div>
      {loadingFavorites && <p role="status">{t("Loading favorites…")}</p>}
      {!loadingFavorites && !favorites.length && <p className="panel-note">{t("Favorite a wallpaper or add your own image. Favorites stay in the local library.")}</p>}
      <div className="background-favorite-grid">{favorites.slice(shownFavoritePage * 50, (shownFavoritePage + 1) * 50).map(favorite => {
        const index = favorite.kind === "wallpaper" ? WALLPAPERS.findIndex(w => w.file === favorite.wallpaperFile) : -1;
        const available = favorite.kind === "image" || index >= 0;
        return <article className={`background-favorite ${selectedFavorite?.id === favorite.id ? "selected" : ""}`} key={favorite.id}>
          <button className="background-favorite-image" disabled={!available || !!pending} title={favorite.name} aria-label={t("Use {name}", { name: favorite.name })} onClick={() => onSelect(favorite.kind === "wallpaper" ? { kind: "wallpaper", wallpaperId: index } : { kind: "image", path: favorite.path, photo: favorite.photo, sha256: favorite.sha256, downloadURL: favorite.downloadURL, downloadedAt: favorite.downloadedAt })}>
            {available ? <img loading="lazy" decoding="async" src={favorite.kind === "wallpaper" ? wallpaperURL(index) : favorite.photo ? favorite.photo.urls.small : services?.mediaURL(favorite.path)} alt={favorite.name} /> : <span>{t("Wallpaper unavailable")}</span>}
          </button>
          <div className="background-favorite-name" title={favorite.kind === "image" ? favorite.sourcePath ?? favorite.path : favorite.wallpaperFile}>{favorite.name}</div>
          {favorite.kind === "image" && favorite.photo && attribution(favorite.photo)}
          <div className="background-favorite-controls">{favorite.kind === "image" && <button className="icon-button" aria-label={t("Reveal image file")} disabled={!services} onClick={() => { void services?.reveal(favorite.path).catch(report); }}><FolderOpen size={12} /></button>}<button className="icon-button" aria-label={t("Remove {name} from favorites", { name: favorite.name })} disabled={!services || !!pending} onClick={() => { void remove(favorite); }}><Trash2 size={12} /></button></div>
        </article>;
      })}</div>
      {favoritePages > 1 && <div className="background-search-pages"><button className="icon-button" aria-label={t("Previous favorites page")} disabled={!shownFavoritePage} onClick={() => setFavoritePage(shownFavoritePage - 1)}><ChevronLeft size={15} /></button><span>{shownFavoritePage + 1} / {favoritePages}</span><button className="icon-button" aria-label={t("Next favorites page")} disabled={shownFavoritePage + 1 >= favoritePages} onClick={() => setFavoritePage(shownFavoritePage + 1)}><ChevronRight size={15} /></button></div>}
      {issues.map(issue => <p className="background-library-issue" key={issue.file}>{issue.file}: {issue.message}</p>)}
    </div> : <div className="background-unsplash" role="tabpanel">
      <label className="background-access-key"><KeyRound size={13} /><input type="password" autoComplete="off" spellCheck={false} aria-label={t("Unsplash access key")} placeholder={t("Unsplash access key — this session only")} value={key} onChange={event => setKey(event.target.value)} />{key && <button className="icon-button" aria-label={t("Clear Unsplash access key")} onClick={() => { request.current++; setSearching(false); setKey(""); setResult(null); }}><X size={12} /></button>}</label>
      <p className="panel-note">{t("Online search uses your access key for this session. Search and photo choices contact Unsplash. Local backgrounds work without a key.")}</p>
      <form className="background-search" onSubmit={event => { event.preventDefault(); void search(); }}><input aria-label={t("Search Unsplash photos")} placeholder={t("Search photos…")} value={query} onChange={event => setQuery(event.target.value)} /><button className="outline-button" type="submit" disabled={!services || !key.trim() || !query.trim() || searching || !!pending}><Search size={13} /></button></form>
      {searching && <p role="status">{t("Searching Unsplash…")}</p>}
      {result && <>
        <div className="background-search-total">{result.total} {t("photos")}{result.rateLimitRemaining !== null ? ` · ${result.rateLimitRemaining} ${t("API requests remaining")}` : ""}</div>
        {!result.photos.length && !searching && <p className="panel-note">{t("No matching photos in this result page.")}</p>}
        <div className="background-photo-grid">{result.photos.map(photo => <article className="background-photo" key={photo.id}>
          <button className="background-photo-image" disabled={!!pending || !key.trim()} aria-label={t("Use photo by {name}", { name: photo.photographer.name })} onClick={() => { void choosePhoto(photo); }}><img loading="lazy" decoding="async" referrerPolicy="no-referrer" src={photo.urls.small} alt={photo.altDescription || photo.description || t("Photo by {name}", { name: photo.photographer.name })} />{pending === photo.id && <span role="status">{t("Saving locally…")}</span>}</button>
          {attribution(photo)}<button className="background-save-photo" disabled={!!pending || !key.trim()} onClick={() => { void choosePhoto(photo, true); }}><Star size={11} />{t("Use and favorite")}</button>
        </article>)}</div>
        {result.omitted > 0 && <p className="background-library-issue">{t("{count} results could not be validated and were omitted.", { count: result.omitted })}</p>}
        {result.totalPages > 1 && <div className="background-search-pages"><button className="icon-button" aria-label={t("Previous photo page")} disabled={result.page <= 1 || searching || !!pending || !key.trim()} onClick={() => { void search(result.page - 1, result.query); }}><ChevronLeft size={15} /></button><span>{result.page} / {result.totalPages}</span><button className="icon-button" aria-label={t("Next photo page")} disabled={result.page >= result.totalPages || searching || !!pending || !key.trim()} onClick={() => { void search(result.page + 1, result.query); }}><ChevronRight size={15} /></button></div>}
      </>}
    </div>}
    {current.kind === "image" && current.photo && <div className="background-current-attribution">{attribution(current.photo)}</div>}
    {!services && <p className="panel-note">{t("The background library bridge is unavailable in this session.")}</p>}
  </section>;
}
