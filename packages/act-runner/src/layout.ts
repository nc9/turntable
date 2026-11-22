/** Where everything lives inside a sandbox. One job per sandbox, so fixed paths are fine. */
export const DEFAULT_ROOT = "/tmp/tt-act";

export interface Layout {
  root: string;
  act: string;
  actTarball: string;
  repoTarball: string;
  /** The delivered repo (with .git). act runs here and the checkout stub copies from here. */
  repo: string;
  stubs: string;
  /** Shims for the interpreters act launches (see step-env.ts), first on the steps' PATH. */
  shims: string;
  /** Where the generated export step writes job outputs, one file per output name. */
  outputsDir: string;
  /** The event payload act reads with --eventpath, when the plan has one. */
  eventFile: string;
}

export function layoutFor(root: string = DEFAULT_ROOT): Layout {
  return {
    root,
    act: `${root}/act`,
    actTarball: `${root}/act.tgz`,
    repoTarball: `${root}/repo.tgz`,
    repo: `${root}/repo`,
    stubs: `${root}/stubs`,
    shims: `${root}/shims`,
    outputsDir: `${root}/outputs`,
    eventFile: `${root}/event.json`,
  };
}
