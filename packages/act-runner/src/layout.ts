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
  /** Where the generated export step writes job outputs, one file per output name. */
  outputsDir: string;
}

export function layoutFor(root: string = DEFAULT_ROOT): Layout {
  return {
    root,
    act: `${root}/act`,
    actTarball: `${root}/act.tgz`,
    repoTarball: `${root}/repo.tgz`,
    repo: `${root}/repo`,
    stubs: `${root}/stubs`,
    outputsDir: `${root}/outputs`,
  };
}
