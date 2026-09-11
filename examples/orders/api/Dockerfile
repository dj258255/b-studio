# 운영용 이미지: 실행 가능한 jar를 이미지 안에서 빌드하고, JRE 이미지에서 전용 사용자로 실행한다
FROM eclipse-temurin:25-jdk AS build

WORKDIR /app
ENV GRADLE_USER_HOME=/cache/gradle

# 빌드 스크립트가 같으면 의존성 층을 다시 쓴다
COPY gradlew settings.gradle build.gradle gradle.properties ./
COPY gradle ./gradle
RUN --mount=type=cache,id=b-studio-gradle,target=/cache/gradle ./gradlew dependencies --no-daemon --console=plain > /dev/null
COPY src ./src
RUN --mount=type=cache,id=b-studio-gradle,target=/cache/gradle ./gradlew bootJar --no-daemon --console=plain \
    && find build/libs -name '*.jar' ! -name '*-plain.jar' -exec cp {} /app/app.jar \;

FROM eclipse-temurin:25-jre

RUN useradd --system --uid 10001 app
WORKDIR /app
COPY --from=build --chown=app:app /app/app.jar ./app.jar

USER app
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
