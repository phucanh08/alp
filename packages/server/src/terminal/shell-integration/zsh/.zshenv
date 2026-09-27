typeset -g ALP_SHELL_INTEGRATION_DIR="${${(%):-%N}:A:h}"

if [[ -n "${ALP_ZSH_ZDOTDIR-}" ]]; then
  export ZDOTDIR="${ALP_ZSH_ZDOTDIR}"
else
  unset ZDOTDIR
fi

if [[ -n "${ZDOTDIR-}" ]]; then
  if [[ -f "${ZDOTDIR}/.zshenv" ]]; then
    source "${ZDOTDIR}/.zshenv"
  fi
elif [[ -f "${HOME}/.zshenv" ]]; then
  source "${HOME}/.zshenv"
fi

source "${ALP_SHELL_INTEGRATION_DIR}/alp-integration.zsh"
