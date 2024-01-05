ARG EXTEND_FROM_compo1='example-registry.com/test/subcompo:latest'
ARG EXTEND_FROM_compoN='example-registry.com/test/subcompo:latest'
FROM ${EXTEND_FROM_compo1}

RUN sleep 5 && echo ${EXTEND_FROM_compo1}

FROM ${EXTEND_FROM_compoN}

RUN sleep 5 && echo ${EXTEND_FROM_compoN}
